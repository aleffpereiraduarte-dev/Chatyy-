/**
 * OneMundo Mail WebSocket Server v4.0 (WhatsApp-inspired)
 * Real-time notifications for email, chat, calendar
 * Port 8081 - runs behind nginx /ws proxy
 *
 * v4.0 changes:
 * - Lightweight connection state (~300 bytes per client, no bloat)
 * - Channel-to-clients index for O(1) message routing
 * - Pre-serialized broadcast (serialize once, send buffer to all)
 * - Message delivery + read acknowledgment flow (msg → ack → delivered → read)
 * - Presence optimization (only notify DM partners, not all clients)
 * - Connection limits per IP (5) and per email (3)
 * - Crash recovery (uncaughtException, unhandledRejection handlers)
 * - Memory monitoring & stats logging every 60s
 * - Dead connection cleanup every 30s
 * - Graceful degradation at 80% memory
 * - Max 100K connections limit
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const Busboy = require('busboy');
const { Client } = require('pg');

const PORT = process.env.WS_PORT || 8081;
const API_KEY = process.env.MAIL_WS_KEY;
if (!API_KEY) { console.error('FATAL: MAIL_WS_KEY environment variable required'); process.exit(1); }
const TURN_SECRET = process.env.TURN_SECRET || '';
if (!process.env.TURN_SECRET) {
  console.error('[WS] WARNING: TURN_SECRET environment variable is not set. Set TURN_SECRET in /etc/mail-api.env');
}
const MAX_MSG = 65536;
const RATE_MAX = 40;
const AUTH_URL = process.env.AUTH_URL || 'http://127.0.0.1/api/email.php?action=check_auth';
const HEARTBEAT_INTERVAL = 25000;
const MAX_CONNECTIONS = 100000;
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_CONNECTIONS_PER_EMAIL = 3;

// ─── Crash Recovery ───
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (process continues):', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (process continues):', reason);
});

// ─── TURN Credentials ───
function generateTurnCredentials(email) {
  const ttl = 86400;
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${timestamp}:${email}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return {
    urls: ['stun:mail.onemundo.com.br:3478', 'turn:mail.onemundo.com.br:3478?transport=udp', 'turn:mail.onemundo.com.br:3478?transport=tcp', 'turns:mail.onemundo.com.br:5349?transport=tcp'],
    username,
    credential,
  };
}

// ─── Lightweight Client State ───
// WhatsApp principle: ~300 bytes per connection
// Only store: ws, email, channels (Set), lastPong, rlCount, rlTime, ip, authTime
const clients = new Map();      // clientId → { ws, email, ip, channels, rlTime, rlCount, authTime, token, name, presenceWatch, isLiveBroadcaster, liveSessionId }
const channels = new Map();     // channelName → Set<clientId>
const emailClients = new Map(); // email → Set<clientId>
const ipConnections = new Map(); // ip → count (lightweight counter, not Set)

// Pending call offers for offline users
const pendingCallOffers = new Map(); // email → { data, timestamp }
// Presence cache: email → { status, last_seen }
const presenceMap = new Map();

// ─── Call State Machine ───
const callStates = new Map(); // call_id → { state, caller, callee, timestamp }

// ─── Stats Counters ───
let stats = { msgIn: 0, msgOut: 0, authSuccess: 0, authFail: 0, rateLimited: 0 };

function getCallState(callId) {
  if (!callId) return null;
  const cs = callStates.get(callId);
  if (cs && (Date.now() - cs.timestamp > 300000)) {
    callStates.delete(callId);
    return null;
  }
  return cs;
}

function setCallState(callId, state, extra = {}) {
  if (!callId) return;
  const existing = callStates.get(callId) || {};
  callStates.set(callId, { ...existing, ...extra, state, timestamp: Date.now() });
}

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Pre-serialized Send ───
// WhatsApp principle: serialize once, send buffer to all
function sendTo(id, data) {
  const c = clients.get(id);
  if (c && c.ws.readyState === WebSocket.OPEN) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    c.ws.send(payload);
    stats.msgOut++;
  }
}

// Send pre-serialized string directly (avoids re-serialization)
function sendRaw(id, serialized) {
  const c = clients.get(id);
  if (c && c.ws.readyState === WebSocket.OPEN) {
    c.ws.send(serialized);
    stats.msgOut++;
  }
}

// ─── Efficient Broadcasting ───
// WhatsApp principle: serialize ONCE, send same buffer to all clients
function broadcast(channel, data, exclude = null) {
  const subs = channels.get(channel);
  if (!subs || subs.size === 0) return 0;
  const payload = JSON.stringify(data);
  let count = 0;
  for (const id of subs) {
    if (id !== exclude) {
      const c = clients.get(id);
      if (c && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(payload);
        count++;
        stats.msgOut++;
      }
    }
  }
  return count;
}

// Broadcast to all clients of a specific email
function broadcastToEmail(email, data, exclude = null) {
  const clientIds = emailClients.get(email);
  if (!clientIds || clientIds.size === 0) return 0;
  const payload = JSON.stringify(data);
  let count = 0;
  for (const id of clientIds) {
    if (id !== exclude) {
      const c = clients.get(id);
      if (c && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(payload);
        count++;
        stats.msgOut++;
      }
    }
  }
  return count;
}

// Send to only the most recent session of an email (for call signals)
function sendToLatestSession(email, data, exclude = null) {
  const clientIds = emailClients.get(email);
  if (!clientIds || clientIds.size === 0) return 0;
  let latestId = null;
  let latestTime = 0;
  for (const id of clientIds) {
    if (id !== exclude) {
      const c = clients.get(id);
      if (c && c.ws.readyState === WebSocket.OPEN && (c.authTime || 0) >= latestTime) {
        latestTime = c.authTime || 0;
        latestId = id;
      }
    }
  }
  if (latestId) {
    const c = clients.get(latestId);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify(data));
      stats.msgOut++;
      return 1;
    }
  }
  return 0;
}

function sub(clientId, channel) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(clientId);
  const c = clients.get(clientId);
  if (c) c.channels.add(channel);
}

function unsub(clientId, channel) {
  const subs = channels.get(channel);
  if (subs) {
    subs.delete(clientId);
    if (subs.size === 0) channels.delete(channel);
  }
  const c = clients.get(clientId);
  if (c) c.channels.delete(channel);
}

// ─── Presence Optimization ───
// WhatsApp principle: only send presence to users watching this user (DM partners)
// Instead of iterating ALL clients, only notify presenceWatch subscribers
function broadcastPresence(email, status, excludeId = null) {
  const presenceData = JSON.stringify({
    type: 'presence',
    email,
    status,
    last_seen: status === 'offline' ? Date.now() : undefined,
  });

  // Notify presence watchers only (not all clients)
  for (const [cid, client] of clients) {
    if (cid !== excludeId && client.presenceWatch && client.presenceWatch.has(email) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(presenceData);
      stats.msgOut++;
    }
  }
}

function disconnect(clientId) {
  const c = clients.get(clientId);
  if (!c) return;

  // If this was a live broadcaster, notify viewers and end the session
  if (c.isLiveBroadcaster && c.liveSessionId) {
    const liveCh = `live_${c.liveSessionId}`;
    broadcast(liveCh, {
      type: 'live_ended',
      session_id: c.liveSessionId,
    }, clientId);
    console.log(`[Live] Broadcaster ${c.email} disconnected, ending session ${c.liveSessionId}`);
    fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.token || ''}` },
      body: JSON.stringify({ action: 'live_end', session_id: c.liveSessionId }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  // Remove from email index
  if (c.email && emailClients.has(c.email)) {
    emailClients.get(c.email).delete(clientId);
    if (emailClients.get(c.email).size === 0) {
      emailClients.delete(c.email);
      // Update presence to offline when last session disconnects
      presenceMap.set(c.email, { status: 'offline', last_seen: Date.now() });
      // Broadcast offline presence to watchers only
      broadcastPresence(c.email, 'offline', clientId);
      // Also notify chat channels this user was in
      for (const ch of c.channels) {
        if (ch.startsWith('chat_') && !ch.startsWith('chat_user_')) {
          broadcast(ch, {
            type: 'presence',
            email: c.email,
            status: 'offline',
            last_seen: Date.now(),
          }, clientId);
        }
      }
    }
  }

  // Remove from all channels
  for (const ch of c.channels) {
    const subs = channels.get(ch);
    if (subs) {
      subs.delete(clientId);
      if (subs.size === 0) channels.delete(ch);
    }
  }

  // Decrement IP connection count
  if (c.ip) {
    const count = ipConnections.get(c.ip) || 0;
    if (count <= 1) {
      ipConnections.delete(c.ip);
    } else {
      ipConnections.set(c.ip, count - 1);
    }
  }

  clients.delete(clientId);
  console.log(`[WS] Disconnected: ${clientId} (${clients.size} active)`);
}

// ─── Auth Validation ───
async function validateToken(token) {
  try {
    const resp = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Cookie': `PHPSESSID=${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.success && data.data?.email) {
      return { email: data.data.email, name: data.data.name || '' };
    }
    return null;
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    return null;
  }
}

// Verify chat membership
async function verifyChatMembership(email, conversationId) {
  try {
    const resp = await fetch('http://127.0.0.1/api/chat.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WS-Internal': API_KEY,
      },
      body: JSON.stringify({ action: 'chat_group_info', conversation_id: conversationId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.success || !data.data?.members) return false;
    return data.data.members.some(m => m.email === email);
  } catch (err) {
    console.error('[ChatMembership] Error:', err.message);
    return false;
  }
}

// ─── Rate Limiting (compact) ───
function isRateLimited(c) {
  const now = Date.now();
  if (!c.rlTime || now - c.rlTime > 1000) {
    c.rlTime = now;
    c.rlCount = 1;
    return false;
  }
  c.rlCount++;
  if (c.rlCount > RATE_MAX) {
    stats.rateLimited++;
    return true;
  }
  return false;
}

// ─── Memory Pressure Check ───
function isMemoryPressure() {
  const mem = process.memoryUsage();
  // Graceful degradation: reject new connections when RSS > 512MB
  return mem.rss > 512 * 1024 * 1024;
}

// ─── Message Handler ───
async function handleMessage(clientId, raw) {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MSG) {
      sendTo(clientId, { type: 'error', message: 'Message too large' });
      return;
    }

    const c = clients.get(clientId);
    if (!c) return;

    stats.msgIn++;

    if (isRateLimited(c)) {
      sendTo(clientId, { type: 'error', message: 'Rate limit exceeded' });
      return;
    }

    const msg = JSON.parse(raw);

    // Log call-related messages
    if (msg.type && msg.type.startsWith('call_')) {
      console.log(`[WS] ${msg.type} from=${c.email || 'unauth'} target=${msg.target_email || '-'} call_id=${msg.call_id || '-'} has_sdp=${!!msg.sdp}`);
    }

    switch (msg.type) {
      case 'auth': {
        const token = msg.token;
        if (!token) {
          sendTo(clientId, { type: 'auth_error', message: 'Token required' });
          return;
        }
        const user = await validateToken(token);
        if (user) {
          // ─── Connection limit per email ───
          const existingSessions = emailClients.get(user.email);
          if (existingSessions && existingSessions.size >= MAX_CONNECTIONS_PER_EMAIL) {
            // Evict oldest session to make room (WhatsApp behavior: new device kicks oldest)
            let oldestId = null;
            let oldestTime = Infinity;
            for (const sid of existingSessions) {
              const sc = clients.get(sid);
              if (sc && (sc.authTime || 0) < oldestTime) {
                oldestTime = sc.authTime || 0;
                oldestId = sid;
              }
            }
            if (oldestId) {
              const oldClient = clients.get(oldestId);
              if (oldClient && oldClient.ws.readyState === WebSocket.OPEN) {
                oldClient.ws.send(JSON.stringify({ type: 'session_replaced', message: 'New session opened' }));
                oldClient.ws.close(4002, 'Session replaced');
              }
              disconnect(oldestId);
              console.log(`[Auth] Evicted oldest session ${oldestId} for ${user.email} (max ${MAX_CONNECTIONS_PER_EMAIL})`);
            }
          }

          c.email = user.email;
          c.name = user.name;
          c.token = token;
          c.authTime = Date.now();

          // Register in email index
          if (!emailClients.has(user.email)) emailClients.set(user.email, new Set());
          emailClients.get(user.email).add(clientId);

          // Auto-subscribe to personal channels
          sub(clientId, `mail_${user.email}`);
          sub(clientId, `chat_user_${user.email}`);

          // Update presence
          presenceMap.set(user.email, { status: 'online', last_seen: Date.now() });

          sendTo(clientId, {
            type: 'auth_success',
            email: user.email,
            name: user.name,
            server_ts: Date.now(),
          });
          stats.authSuccess++;
          console.log(`[Auth] ${user.email} authenticated`);

          // Broadcast online presence to watchers only
          broadcastPresence(user.email, 'online', clientId);

          // Deliver pending call offers
          const pending = pendingCallOffers.get(user.email);
          if (pending && (Date.now() - pending.timestamp < 60000)) {
            sendTo(clientId, pending.data);
            console.log(`[Call] Delivered pending offer to ${user.email}`);
          }
          pendingCallOffers.delete(user.email);
        } else {
          stats.authFail++;
          sendTo(clientId, { type: 'auth_error', message: 'Invalid or expired token' });
        }
        break;
      }

      case 'ping':
        sendTo(clientId, { type: 'pong', ts: Date.now() });
        break;

      case 'subscribe':
        if (!c.email || !msg.channel) break;
        if (
          msg.channel === `mail_${c.email}` ||
          msg.channel === `calendar_${c.email}`
        ) {
          sub(clientId, msg.channel);
          sendTo(clientId, { type: 'subscribed', channel: msg.channel });
        } else if (msg.channel.startsWith('live_')) {
          sub(clientId, msg.channel);
          sendTo(clientId, { type: 'subscribed', channel: msg.channel });
        } else if ((msg.channel.startsWith('chat_') || msg.channel.startsWith('doc_')) && !msg.channel.startsWith('chat_user_')) {
          const convId = msg.channel.replace(/^(chat_|doc_)/, '');
          verifyChatMembership(c.email, convId).then(isMember => {
            if (isMember) {
              sub(clientId, msg.channel);
              sendTo(clientId, { type: 'subscribed', channel: msg.channel });
            } else {
              sendTo(clientId, { type: 'subscribe_error', channel: msg.channel, message: 'Not a member of this conversation' });
              console.log(`[Auth] ${c.email} denied subscription to ${msg.channel} (not a member)`);
            }
          }).catch(() => {
            sendTo(clientId, { type: 'subscribe_error', channel: msg.channel, message: 'Membership check failed' });
          });
        }
        break;

      case 'unsubscribe':
        if (msg.channel) {
          unsub(clientId, msg.channel);
          sendTo(clientId, { type: 'unsubscribed', channel: msg.channel });
        }
        break;

      // ─── Call Signaling with State Machine ───

      case 'call_invite':
        if (c.email && msg.target_email) {
          const callId = msg.call_id || msg.room_id || '';
          setCallState(callId, 'RINGING', { caller: c.email, callee: msg.target_email });
          const invitePayload = {
            type: 'call_invite',
            call_id: callId,
            caller_email: c.email,
            caller_name: c.name,
            conversation_id: msg.conversation_id || '',
            room_id: callId,
            video: msg.video !== false,
          };
          const delivered = sendToLatestSession(msg.target_email, invitePayload);
          console.log(`[Call] call_invite ${c.email} -> ${msg.target_email} [${callId}]: ${delivered > 0 ? 'delivered' : 'offline'}`);
        }
        break;

      case 'call_accepted': {
        if (!c.email || !msg.target_email) break;
        const callId = msg.call_id || '';
        const cs = getCallState(callId);
        if (cs && cs.state !== 'RINGING') {
          console.log(`[Call] call_accepted REJECTED (state=${cs.state}) ${c.email} [${callId}]`);
          break;
        }
        setCallState(callId, 'ACCEPTED', { acceptedBy: c.email });
        console.log(`[Call] call_accepted ${c.email} -> ${msg.target_email} [${callId}]`);
        broadcastToEmail(msg.target_email, {
          type: 'call_accepted',
          call_id: callId,
          email: c.email,
          conversation_id: msg.conversation_id || '',
        });
        broadcastToEmail(c.email, { type: 'call_dismissed', call_id: callId }, clientId);
        break;
      }

      case 'call_declined': {
        if (!c.email) break;
        const callId = msg.call_id || msg.room_id || '';
        const cs = getCallState(callId);
        if (cs && cs.state !== 'RINGING') {
          console.log(`[Call] call_declined REJECTED (state=${cs.state}) ${c.email} [${callId}]`);
          break;
        }
        setCallState(callId, 'DECLINED');
        console.log(`[Call] call_declined ${c.email} [${callId}]`);
        if (cs?.caller) {
          broadcastToEmail(cs.caller, {
            type: 'call_declined',
            email: c.email,
            call_id: callId,
          });
        }
        break;
      }

      case 'call_offer':
        if (c.email && msg.target_email) {
          const turnCreds = generateTurnCredentials(c.email);
          sendTo(clientId, { type: 'call_turn_credentials', call_id: msg.call_id, credentials: turnCreds });
          const offerPayload = {
            type: 'call_offer',
            call_id: msg.call_id,
            caller_email: c.email,
            caller_name: c.name,
            conversation_id: msg.conversation_id,
            sdp: msg.sdp,
            sdp_type: msg.sdp_type || 'offer',
            video: msg.video || false,
            turn_credentials: turnCreds,
          };
          const delivered = sendToLatestSession(msg.target_email, offerPayload);
          console.log(`[Call] call_offer ${c.email} -> ${msg.target_email} [${msg.call_id}]: ${delivered > 0 ? 'delivered' : 'offline'}`);
          if (delivered === 0) {
            pendingCallOffers.set(msg.target_email, { data: offerPayload, timestamp: Date.now() });
          }
        }
        break;

      case 'call_answer':
        if (c.email && msg.target_email) {
          console.log(`[Call] call_answer ${c.email} -> ${msg.target_email} [${msg.call_id}]`);
          broadcastToEmail(msg.target_email, {
            type: 'call_answer',
            call_id: msg.call_id,
            sdp: msg.sdp,
            sdp_type: msg.sdp_type || 'answer',
            answerer_email: c.email,
          });
        }
        break;

      case 'call_ice':
        if (c.email && msg.target_email) {
          broadcastToEmail(msg.target_email, {
            type: 'call_ice',
            call_id: msg.call_id,
            candidate: msg.candidate,
          });
        }
        break;

      case 'call_request_offer':
        if (c.email) {
          const pendingOffer = pendingCallOffers.get(c.email);
          if (pendingOffer && (Date.now() - pendingOffer.timestamp < 60000)) {
            if (!msg.call_id || pendingOffer.data.call_id === msg.call_id) {
              sendTo(clientId, pendingOffer.data);
              console.log(`[Call] Re-delivered pending offer to ${c.email}`);
            }
          }
        }
        break;

      case 'call_end': {
        if (!c.email || !msg.target_email) break;
        const callId = msg.call_id || '';
        const reason = msg.reason || 'hangup';
        const cs = getCallState(callId);

        if (cs && cs.state === 'ACCEPTED' && reason === 'declined') {
          console.log(`[Call] call_end BLOCKED (declined after accepted) ${c.email} [${callId}]`);
          break;
        }

        if (reason === 'declined' && cs && cs.callee === c.email && cs.state === 'RINGING') {
          console.log(`[Call] call_end DELAYED (declined from callee, waiting 2s) ${c.email} [${callId}]`);
          const targetEmail = msg.target_email;
          setTimeout(() => {
            const csNow = getCallState(callId);
            if (csNow && csNow.state === 'ACCEPTED') {
              console.log(`[Call] call_end DROPPED (accepted during delay) ${c.email} [${callId}]`);
              return;
            }
            setCallState(callId, 'ENDED');
            console.log(`[Call] call_end ${c.email} -> ${targetEmail} [${callId}]: declined (after delay)`);
            broadcastToEmail(targetEmail, { type: 'call_end', call_id: callId, reason: 'declined' });
            pendingCallOffers.delete(targetEmail);
          }, 2000);
          break;
        }

        setCallState(callId, 'ENDED');
        console.log(`[Call] call_end ${c.email} -> ${msg.target_email} [${callId}]: ${reason}`);
        broadcastToEmail(msg.target_email, { type: 'call_end', call_id: callId, reason });
        pendingCallOffers.delete(msg.target_email);
        break;
      }

      case 'get_turn_credentials':
        if (c.email) {
          sendTo(clientId, { type: 'turn_credentials', credentials: generateTurnCredentials(c.email) });
        }
        break;

      case 'call_debug':
        if (c.email) {
          console.log(`[Call Debug] ${c.email}: ${msg.error || msg.msg || JSON.stringify(msg)}`);
        }
        break;

      // ─── Live Streaming Signaling ───

      case 'live_start':
        if (c.email && msg.session_id) {
          sub(clientId, `live_${msg.session_id}`);
          c.liveSessionId = msg.session_id;
          c.isLiveBroadcaster = true;
          console.log(`[Live] ${c.email} started broadcast ${msg.session_id}`);
          sendTo(clientId, { type: 'live_started', session_id: msg.session_id });
        }
        break;

      case 'live_join':
        if (c.email && msg.session_id) {
          const liveCh = `live_${msg.session_id}`;
          sub(clientId, liveCh);
          broadcast(liveCh, {
            type: 'live_viewer_joined',
            session_id: msg.session_id,
            viewer_email: c.email,
            viewer_name: c.name,
            viewer_id: clientId,
          }, clientId);
          console.log(`[Live] ${c.email} joined broadcast ${msg.session_id}`);
          sendTo(clientId, { type: 'live_joined', session_id: msg.session_id });
        }
        break;

      case 'live_end':
        if (c.email && msg.session_id) {
          broadcast(`live_${msg.session_id}`, { type: 'live_ended', session_id: msg.session_id }, clientId);
          console.log(`[Live] ${c.email} ended broadcast ${msg.session_id}`);
        }
        break;

      case 'live_offer':
        if (c.email && msg.session_id && msg.viewer_id) {
          const turnCreds = generateTurnCredentials(c.email);
          sendTo(msg.viewer_id, {
            type: 'live_offer',
            session_id: msg.session_id,
            sdp: msg.sdp,
            broadcaster_email: c.email,
            turn_credentials: turnCreds,
          });
          sendTo(clientId, { type: 'live_turn_credentials', session_id: msg.session_id, credentials: turnCreds });
          console.log(`[Live] offer ${c.email} -> viewer ${msg.viewer_id}`);
        }
        break;

      case 'live_answer':
        if (c.email && msg.session_id && msg.broadcaster_email) {
          broadcastToEmail(msg.broadcaster_email, {
            type: 'live_answer',
            session_id: msg.session_id,
            sdp: msg.sdp,
            viewer_email: c.email,
            viewer_id: clientId,
          });
          console.log(`[Live] answer ${c.email} -> broadcaster ${msg.broadcaster_email}`);
        }
        break;

      case 'live_ice':
        if (c.email && msg.session_id) {
          if (msg.viewer_id) {
            sendTo(msg.viewer_id, {
              type: 'live_ice',
              session_id: msg.session_id,
              candidate: msg.candidate,
              from: c.email,
            });
          } else if (msg.broadcaster_email) {
            broadcastToEmail(msg.broadcaster_email, {
              type: 'live_ice',
              session_id: msg.session_id,
              candidate: msg.candidate,
              viewer_id: clientId,
              from: c.email,
            });
          }
        }
        break;

      case 'live_chat':
        if (c.email && msg.session_id && msg.content) {
          broadcast(`live_${msg.session_id}`, {
            type: 'live_chat',
            session_id: msg.session_id,
            sender_email: c.email,
            sender_name: c.name,
            content: msg.content,
            timestamp: Date.now(),
          });
        }
        break;

      case 'live_reaction':
        if (c.email && msg.session_id && msg.emoji) {
          broadcast(`live_${msg.session_id}`, {
            type: 'live_reaction',
            session_id: msg.session_id,
            email: c.email,
            name: c.name,
            emoji: msg.emoji,
          }, clientId);
        }
        break;

      // ─── Chat Messages ───

      case 'typing':
        if (c.email && msg.conversation_id) {
          broadcast(`chat_${msg.conversation_id}`, {
            type: 'typing',
            email: c.email,
            name: c.name,
            conversation_id: msg.conversation_id,
            recording: !!msg.recording,
          }, clientId);
        }
        break;

      case 'stopped_typing':
        if (c.email && msg.conversation_id) {
          broadcast(`chat_${msg.conversation_id}`, {
            type: 'stopped_typing',
            email: c.email,
            conversation_id: msg.conversation_id,
          }, clientId);
        }
        break;

      case 'chat_message_relay':
        // WhatsApp principle: receive -> lookup -> forward -> deliver (in-memory, no queues)
        if (c.email && msg.conversation_id && msg.message) {
          const chatCh = `chat_${msg.conversation_id}`;
          const relayPayload = {
            type: 'chat_message',
            conversation_id: msg.conversation_id,
            message: msg.message,
          };
          const relayed = broadcast(chatCh, relayPayload, clientId);
          // Send ack back to sender
          sendTo(clientId, {
            type: 'message_ack',
            temp_id: msg.temp_id || '',
            message_id: msg.message?.id,
            conversation_id: msg.conversation_id,
            delivered_to: relayed,
            ts: Date.now(),
          });
        }
        break;

      // ─── Message Delivery Acknowledgment ───
      // WhatsApp flow: msg -> ack -> delivered -> read

      case 'message_delivered':
        // Client confirms it received a chat message
        if (c.email && msg.message_id && msg.conversation_id) {
          // Forward delivery receipt to the sender
          if (msg.sender_email) {
            broadcastToEmail(msg.sender_email, {
              type: 'message_delivered',
              message_id: msg.message_id,
              conversation_id: msg.conversation_id,
              delivered_to: c.email,
              ts: Date.now(),
            });
          } else {
            // Broadcast to the conversation channel so sender picks it up
            broadcast(`chat_${msg.conversation_id}`, {
              type: 'message_delivered',
              message_id: msg.message_id,
              conversation_id: msg.conversation_id,
              delivered_to: c.email,
              ts: Date.now(),
            }, clientId);
          }
        }
        break;

      case 'message_read':
        // Client confirms it read messages in a conversation
        if (c.email && msg.conversation_id) {
          broadcast(`chat_${msg.conversation_id}`, {
            type: 'message_read',
            message_ids: msg.message_ids || [],
            conversation_id: msg.conversation_id,
            read_by: c.email,
            ts: Date.now(),
          }, clientId);
        }
        break;

      // ─── Presence ───

      case 'presence_query':
        if (c.email && Array.isArray(msg.emails)) {
          const results = {};
          const slice = msg.emails.slice(0, 50);
          for (const email of slice) {
            if (emailClients.has(email)) {
              results[email] = { status: 'online' };
            } else {
              const p = presenceMap.get(email);
              results[email] = p || { status: 'offline', last_seen: 0 };
            }
          }
          sendTo(clientId, { type: 'presence_result', presences: results });
        }
        break;

      case 'presence_subscribe':
        if (c.email && Array.isArray(msg.emails)) {
          if (!c.presenceWatch) c.presenceWatch = new Set();
          for (const email of msg.emails.slice(0, 20)) {
            c.presenceWatch.add(email);
          }
        }
        break;

      case 'presence_unsubscribe':
        // Allow clients to stop watching presence
        if (c.email && Array.isArray(msg.emails)) {
          if (c.presenceWatch) {
            for (const email of msg.emails) {
              c.presenceWatch.delete(email);
            }
          }
        }
        break;
    }
  } catch (err) {
    console.error('[WS] Error:', err.message);
  }
}

// ─── HTTP Server ───
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ─── Health + Stats Endpoint ───
  if (req.url === '/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      version: '4.0',
      clients: clients.size,
      channels: channels.size,
      emails: emailClients.size,
      presences: presenceMap.size,
      uptime: process.uptime(),
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        external_mb: Math.round(mem.external / 1024 / 1024),
      },
      stats: { ...stats },
      limits: {
        max_connections: MAX_CONNECTIONS,
        max_per_ip: MAX_CONNECTIONS_PER_IP,
        max_per_email: MAX_CONNECTIONS_PER_EMAIL,
      },
    }));
  }

  // ─── Photo Upload (S3 direct) ───
  if (req.method === 'POST' && req.url === '/upload-photo') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'No token' }));
    }

    const fs = require('fs');
    const path = require('path');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenFile = `/var/www/mail/data/tokens/${tokenHash}.json`;
    let email = '';
    try {
      if (fs.existsSync(tokenFile)) {
        const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
        email = (tokenData.email || '').toLowerCase();
        if (tokenData.expires_at && tokenData.expires_at < Math.floor(Date.now() / 1000)) {
          email = '';
        }
      }
    } catch {}
    if (!email) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Invalid token' }));
    }

    (async () => {
      try {
        const userHash = crypto.createHash('md5').update(email).digest('hex');
        let filename = 'photo.jpg';
        let mimeType = 'image/jpeg';
        let deviceName = '';

        const bb = Busboy({ headers: req.headers, limits: { fileSize: 200 * 1024 * 1024 } });
        const chunks = [];

        await new Promise((resolve, reject) => {
          bb.on('file', (fieldname, stream, info) => {
            filename = info.filename || 'photo.jpg';
            mimeType = info.mimeType || 'image/jpeg';
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {});
          });
          bb.on('field', (name, val) => {
            if (name === 'device_name') deviceName = val;
            if (name === 'filename') filename = val;
          });
          bb.on('finish', resolve);
          bb.on('error', reject);
          req.pipe(bb);
        });

        if (chunks.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, message: 'No file' }));
        }

        const fileBuffer = Buffer.concat(chunks);
        const uuid = crypto.randomBytes(8).toString('hex');
        const s3Key = `${userHash}/${uuid}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

        const s3 = new S3Client({
          region: process.env.S3_REGION || 'nbg1',
          endpoint: process.env.S3_ENDPOINT || 'https://nbg1.your-objectstorage.com',
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY,
            secretAccessKey: process.env.S3_SECRET_KEY,
          },
          forcePathStyle: true,
        });

        await s3.send(new PutObjectCommand({
          Bucket: process.env.S3_BUCKET || 'mailonemundo',
          Key: s3Key,
          Body: fileBuffer,
          ContentType: mimeType,
        }));

        const pg = new Client({
          host: process.env.PG_HOST || 'localhost',
          port: parseInt(process.env.PG_PORT || '5432'),
          database: process.env.PG_DATABASE || 'chatyy',
          user: process.env.PG_USER || 'chatyy',
          password: process.env.PG_PASSWORD || '',
        });
        await pg.connect();

        let backupFolderId;
        const folderRes = await pg.query(
          "SELECT id FROM drive_files WHERE user_email = $1 AND name = 'Photo Backup' AND parent_id IS NULL AND is_folder = 1 AND is_trashed = 0",
          [email]
        );
        if (folderRes.rows.length > 0) {
          backupFolderId = folderRes.rows[0].id;
        } else {
          const ins = await pg.query(
            "INSERT INTO drive_files (user_email, name, path, mime_type, size, disk_path, parent_id, is_folder, media_type, source, created_at, updated_at) VALUES ($1, 'Photo Backup', '/', 'inode/directory', 0, '', NULL, 1, 'other', 'system', NOW()::text, NOW()::text) RETURNING id",
            [email]
          );
          backupFolderId = ins.rows[0].id;
        }

        let parentForMonth = backupFolderId;
        if (deviceName) {
          deviceName = deviceName.replace(/[\/\\<>:"|?*]/g, '').substring(0, 100);
          const devRes = await pg.query(
            "SELECT id FROM drive_files WHERE user_email = $1 AND name = $2 AND parent_id = $3 AND is_folder = 1 AND is_trashed = 0",
            [email, deviceName, backupFolderId]
          );
          if (devRes.rows.length > 0) {
            parentForMonth = devRes.rows[0].id;
          } else {
            const ins = await pg.query(
              "INSERT INTO drive_files (user_email, name, path, mime_type, size, disk_path, parent_id, is_folder, media_type, source, created_at, updated_at) VALUES ($1, $2, '/Photo Backup/', 'inode/directory', 0, '', $3, 1, 'other', 'system', NOW()::text, NOW()::text) RETURNING id",
              [email, deviceName, backupFolderId]
            );
            parentForMonth = ins.rows[0].id;
          }
        }

        const month = new Date().toISOString().slice(0, 7);
        let monthFolderId;
        const monthRes = await pg.query(
          "SELECT id FROM drive_files WHERE user_email = $1 AND name = $2 AND parent_id = $3 AND is_folder = 1 AND is_trashed = 0",
          [email, month, parentForMonth]
        );
        if (monthRes.rows.length > 0) {
          monthFolderId = monthRes.rows[0].id;
        } else {
          const pathPrefix = deviceName ? `/Photo Backup/${deviceName}/` : '/Photo Backup/';
          const ins = await pg.query(
            "INSERT INTO drive_files (user_email, name, path, mime_type, size, disk_path, parent_id, is_folder, media_type, source, created_at, updated_at) VALUES ($1, $2, $3, 'inode/directory', 0, '', $4, 1, 'other', 'system', NOW()::text, NOW()::text) RETURNING id",
            [email, month, pathPrefix, parentForMonth]
          );
          monthFolderId = ins.rows[0].id;
        }

        const mediaType = mimeType.startsWith('video') ? 'video' : 'photo';
        const fileRes = await pg.query(
          "INSERT INTO drive_files (user_email, name, path, mime_type, size, disk_path, parent_id, is_folder, media_type, source, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'backup', NOW()::text, NOW()::text) RETURNING id",
          [email, filename, `/Photo Backup/${month}/`, mimeType, fileBuffer.length, `s3://${s3Key}`, monthFolderId, mediaType]
        );

        await pg.query(
          "INSERT INTO drive_storage_usage (user_email, drive_used, total_used) VALUES ($1, $2, $2) ON CONFLICT (user_email) DO UPDATE SET drive_used = drive_storage_usage.drive_used + $2, total_used = drive_storage_usage.total_used + $2",
          [email, fileBuffer.length]
        );

        await pg.end();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: fileRes.rows[0].id, size: fileBuffer.length } }));

      } catch (err) {
        console.error('[upload] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    })();
    return;
  }

  // ─── Broadcast to channel (called by PHP backend) ───
  if (req.method === 'POST' && req.url === '/broadcast') {
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 1024 * 1024;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        if (req.headers['x-api-key'] !== API_KEY) {
          res.writeHead(401);
          return res.end('Unauthorized');
        }
        const data = JSON.parse(body);
        const count = broadcast(data.channel, {
          type: data.event || data.type,
          data: data.data,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, delivered: count }));
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
    return;
  }

  // ─── Notify by email (called by push-notify.php) ───
  if (req.method === 'POST' && req.url === '/notify') {
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 1024 * 1024;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        if (req.headers['x-api-key'] !== API_KEY) {
          res.writeHead(401);
          return res.end('Unauthorized');
        }
        const data = JSON.parse(body);
        let count = 0;
        if (data.email) {
          count = broadcastToEmail(data.email, { type: data.event, data: data.data });
        } else if (data.channel) {
          count = broadcast(data.channel, { type: data.event, data: data.data });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, delivered: count }));
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ─── WebSocket Server ───
const wss = new WebSocket.Server({
  server,
  maxPayload: 65536,
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    threshold: 128,
  },
});

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  // ─── Connection limit: total ───
  if (clients.size >= MAX_CONNECTIONS) {
    ws.close(4003, 'Server full');
    return;
  }

  // ─── Connection limit: per IP ───
  const ipCount = ipConnections.get(ip) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    console.log(`[WS] Rejected connection from ${ip} (${ipCount} already, max ${MAX_CONNECTIONS_PER_IP})`);
    ws.close(4004, 'Too many connections from this IP');
    return;
  }
  ipConnections.set(ip, ipCount + 1);

  // ─── Memory pressure check ───
  if (isMemoryPressure()) {
    console.log('[WS] Rejected connection: memory pressure');
    ipConnections.set(ip, (ipConnections.get(ip) || 1) - 1);
    ws.close(4005, 'Server under load');
    return;
  }

  const id = genId();

  // Lightweight client state (WhatsApp: ~300 bytes per connection)
  clients.set(id, {
    ws,
    ip,
    email: null,
    name: null,
    channels: new Set(),
    rlTime: 0,
    rlCount: 0,
    authTime: 0,
    token: null,
    // presenceWatch, isLiveBroadcaster, liveSessionId added on demand
  });

  console.log(`[WS] Connected: ${id} from ${ip} (${clients.size} active)`);
  sendTo(id, { type: 'welcome', clientId: id });

  // Auth timeout: disconnect if not authenticated within 10s
  const authTimeout = setTimeout(() => {
    const c = clients.get(id);
    if (c && !c.email) {
      console.log(`[Auth] Timeout: ${id} from ${ip} (not authenticated in 10s)`);
      sendTo(id, { type: 'auth_error', message: 'Authentication timeout' });
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (data) => handleMessage(id, data.toString()));
  ws.on('close', () => { clearTimeout(authTimeout); disconnect(id); });
  ws.on('error', () => { clearTimeout(authTimeout); disconnect(id); });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// ─── Heartbeat: terminate dead connections (25s) ───
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ─── Dead Connection Cleanup (30s) ───
// Catches connections that slip through heartbeat (e.g., half-open TCP)
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (c.ws.readyState === WebSocket.CLOSED || c.ws.readyState === WebSocket.CLOSING) {
      disconnect(id);
    }
  }
  // Cleanup stale pending call offers
  for (const [email, offer] of pendingCallOffers) {
    if (now - offer.timestamp > 60000) {
      pendingCallOffers.delete(email);
    }
  }
  if (pendingCallOffers.size > 10000) {
    let removed = 0;
    for (const key of pendingCallOffers.keys()) {
      if (removed >= pendingCallOffers.size - 10000) break;
      pendingCallOffers.delete(key);
      removed++;
    }
  }
  // Cleanup stale call states
  for (const [id, cs] of callStates) {
    if (now - cs.timestamp > 300000) callStates.delete(id);
  }
  // Cleanup stale presence entries (offline > 24h)
  for (const [email, p] of presenceMap) {
    if (p.status === 'offline' && p.last_seen && (now - p.last_seen > 86400000)) {
      presenceMap.delete(email);
    }
  }
  // Cleanup ipConnections with 0 count
  for (const [ip, count] of ipConnections) {
    if (count <= 0) ipConnections.delete(ip);
  }
}, 30000);

// ─── Stats & Monitoring (60s) ───
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(
    `[Stats] clients=${clients.size} channels=${channels.size} emails=${emailClients.size} ` +
    `rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB ` +
    `msgIn=${stats.msgIn} msgOut=${stats.msgOut} auth=${stats.authSuccess}/${stats.authFail} ` +
    `rateLimited=${stats.rateLimited} uptime=${Math.round(process.uptime())}s`
  );
  // Reset per-interval counters
  stats.msgIn = 0;
  stats.msgOut = 0;
  stats.rateLimited = 0;
}, 60000);

// ─── Start Server ───
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Mail WS] Server v4.0 on port ${PORT}`);
});

// ─── Graceful Shutdown ───
function gracefulShutdown(signal) {
  console.log(`[WS] ${signal} received, shutting down gracefully...`);
  // Close all client connections with a goodbye
  for (const [id, c] of clients) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.close(1001, 'Server shutting down');
    }
  }
  wss.close(() => {
    server.close(() => {
      console.log('[WS] Server closed');
      process.exit(0);
    });
  });
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
