# WHATSAPP vs CHATYY - TECHNICAL ARCHITECTURE DEEP DIVE

## EXECUTIVE SUMMARY

WhatsApp's backend is built on **Erlang/BEAM/Ejabberd** (concurrent, reliable, 2-3M connections per server), while Chatyy uses **Node.js WebSocket + PostgreSQL + MQTT**. Both work at scale, but WhatsApp's architecture is optimized for **extreme concurrency and message reliability**, while Chatyy is more **modern and flexible**.

**Key architectural differences:**
- **Message Delivery**: WhatsApp (Mnesia in-memory queue + Kafka) vs Chatyy (PostgreSQL + Redis + MQTT)
- **Real-time Transport**: WhatsApp (XMPP + modified protocol) vs Chatyy (WebSocket + MQTT)
- **Encryption**: WhatsApp (Signal Protocol + Protobuf) vs Chatyy (NaCl E2EE + JSON)
- **Scalability**: WhatsApp (Erlang lightweight processes) vs Chatyy (Node.js event loop + clustering)
- **Media**: WhatsApp (S3 + CDN with content-based hashing) vs Chatyy (Cloudflare R2 + CDN)
- **Calling**: WhatsApp (proprietary protocol) vs Chatyy (WebRTC + SIP)

---

## PART 1: MESSAGE DELIVERY SYSTEM

### WhatsApp Architecture

```
Client → WebSocket Connection → Ejabberd Server (Erlang/BEAM)
                                        ↓
                                  Mnesia DB (in-memory queue)
                                        ↓
                                   [Message routing]
                                        ↓
                                   Recipient Server
                                        ↓
                                      Client
```

**Components:**

1. **Ejabberd Server** (Custom-modified)
   - Language: Erlang
   - Runtime: BEAM (Bogdan's Erlang Abstract Machine)
   - OS: FreeBSD
   - Concurrency Model: Lightweight processes (millions per server)
   - One server = 2-3 million concurrent connections
   - Each connection is just a lightweight Erlang process

2. **Mnesia Database**
   - Type: Erlang distributed in-memory DB
   - Storage: RAM (replicated across servers)
   - Data stored:
     - Routing table (which user is on which server)
     - Offline message queue (temporary, undelivered messages)
     - User data (profiles, group memberships)
   - Deletion: Messages deleted after successful delivery ACK
   - Replication: Multi-server for fault tolerance

3. **Message Queue (FIFO)**
   - Storage: Mnesia table
   - Order: Strict FIFO (guarantees message order)
   - Timeout: Messages kept until recipient connects
   - Batching: Can group offline messages

4. **Delivery Guarantee**
   - ACK flow: Sender → Ejabberd ACK → Persists to Mnesia → Routes to recipient
   - Only ACK after persistence (durability guarantee)
   - Timeout retry: Client re-sends with same `client_message_id` if no ACK
   - Deduplication: Server checks `client_message_id`, discards duplicates
   - Pattern: Idempotent delivery (safe to retry)

---

### Chatyy Architecture

```
Client → WebSocket Connection → Node.js WS Server
              ↓
         [Chat.php API]
              ↓
         PostgreSQL + Redis
              ↓
         MQTT Broker (QoS 1)
              ↓
              ↓ (Delta sync)
           Offline Queue
              ↓
          Recipient Client
```

**Components:**

1. **WebSocket Server** (Node.js)
   - `/root/webmail-app/services/websocket.js`
   - Runtime: Node.js event loop
   - Concurrency: Single-threaded event-based
   - Connections: Via clustering, multiple worker processes
   - Auto-reconnect: Exponential backoff (2s → 60s)
   - Deduplication: Last 500 message IDs (FIFO eviction)

2. **Message Persistence**
   - Primary: PostgreSQL (durable)
   - Cache: Redis (fast reads)
   - Backup: MQTT with QoS 1 (guaranteed delivery)
   - Message table columns:
     - `id`, `conversation_id`, `sender_email`, `content`, `type`
     - `created_at`, `delivered_at`, `read_at`, `deleted_at`, `edited_at`
     - `reply_to_id`, `reactions` (JSON), `mentions` (JSON)
     - `is_view_once`, `file_url`

3. **MQTT Broker** (QoS 1 - Guaranteed)
   - Topics:
     - `chatyy/user/{email}/inbox` - Conversation list
     - `chatyy/conv/{conversationId}/messages` - New messages
     - `chatyy/conv/{conversationId}/reactions` - Reactions
     - `chatyy/conv/{conversationId}/deletes` - Deletions
     - `chatyy/conv/{conversationId}/edits` - Edits
   - Persistent session: Broker queues messages if client offline
   - Dedup: Max 2000-entry buffer

4. **Delta Sync** (`chatSync()`)
   - Parameters: `lastSeq`, `limit`
   - Returns: Messages since last sync
   - Used for: Offline catch-up on reconnect
   - Speed: SQL query with timestamp/ID index

5. **Offline Queue** (`savePendingMessage()`)
   - Storage: Device SQLite (native) or MMKV (web)
   - Max: 100 pending messages
   - Retry: On reconnect, auto-send
   - Dedup: `clientMessageId` prevents duplicates

---

### COMPARISON

| Aspect | WhatsApp | Chatyy |
|--------|----------|--------|
| **Server Language** | Erlang | Node.js |
| **Concurrency Model** | Lightweight processes (millions) | Event-based (async/await) |
| **Message Storage** | Mnesia (in-memory, replicated) | PostgreSQL (durable) |
| **Offline Queue** | Mnesia table | Device storage + MQTT |
| **Delivery ACK** | Sender → Ejabberd → Mnesia → Recipient | WS ACK → PG insert → Recipient |
| **Deduplication** | Server checks `client_message_id` | Server checks `clientMessageId` |
| **Order Guarantee** | FIFO in Mnesia | FIFO via timestamp/ID index |
| **Message TTL** | Until ACK received | Persisted forever (PG) |
| **Retry Strategy** | Client retries with backoff | Auto-retry on reconnect |
| **Scaling** | Vertical (single Erlang server = 2-3M conn) | Horizontal (Node.js clustering) |
| **Reliability** | Mnesia replication | PG replication + MQTT backup |

**Key Insight:** WhatsApp optimizes for **instant delivery to online users** (in-memory Mnesia), while Chatyy optimizes for **durability and offline support** (PostgreSQL + MQTT).

---

## PART 2: REAL-TIME COMMUNICATION (TYPING, PRESENCE, REACTIONS)

### WhatsApp Architecture

**Protocol:** Modified XMPP (Extensible Messaging and Presence Protocol)

**Typing Indicators:**
```
User starts typing:
  → Sends "typing_started" event
  → Tiny signal (few bytes)
  → Streamed over persistent TCP connection
  → Recipient sees "..." immediately
  → No polling, event-driven
  
User stops typing (3s idle):
  → Sends "typing_stopped" event
  → Recipient sees typing indicator cleared
```

**Key Points:**
- Event-driven: No polling (expensive at scale)
- Speed: Direct stream over TCP connection
- Memory: Status updates discarded immediately (not persisted)
- Bandwidth: Minimal (few bytes per event)
- Real-time: Sub-millisecond latency for online users

**Presence System:**
```
Client connects:
  → Server marks user "online"
  → Broadcasts "presence_update" to interested peers
  → Stores last_seen timestamp on disconnect
  
"Last Seen" calculation:
  → Timestamp when user went offline
  → Stored in Mnesia
  → Sent when other users query presence
```

---

### Chatyy Architecture

**Protocol:** WebSocket + MQTT

**Typing Indicators** (`services/websocket.js`):
```javascript
// Debounced typing events
const sendTyping = (conversationId, isRecording) => {
  if (timeSinceLastTyping < 3000) return; // Min 3s between sends
  
  ws.send({
    event: 'typing',
    conversationId,
    email: user.email,
    name: user.name,
    recording: isRecording
  });
  
  // Auto-stop after 3s idle
  setTimeout(() => {
    ws.send({ event: 'stopped_typing', conversationId });
  }, 3000);
};
```

**Presence System** (`chatPresence(status)`):
```
// 10-second polling for DM partners
setInterval(() => {
  api.getPresence(partnerId); // HTTP request
}, 10000);

// WS broadcasts for group (on send)
ws.send({ event: 'presence', email, status });
```

**Key Implementation:**
- Debounce: 3s min between typing events
- Stop delay: 3s idle triggers "stopped_typing"
- Polling: 10s interval for presence (not real-time)
- Storage: Presence in-memory only (not persisted)

---

### COMPARISON

| Aspect | WhatsApp | Chatyy |
|--------|----------|--------|
| **Transport** | XMPP + TCP | WebSocket + MQTT |
| **Typing Latency** | Sub-ms (direct stream) | Low-ms (WebSocket) |
| **Presence Polling** | Real-time push | 10s polling interval |
| **Typing Debounce** | Implicit in XMPP | Explicit 3s min |
| **Message Size** | Few bytes per event | JSON overhead |
| **Bandwidth** | Minimal | Minimal (debounce helps) |
| **Reliability** | TCP guaranteed | WebSocket with reconnect |
| **Scaling** | Erlang processes | Event loop + MQTT |

**Key Insight:** WhatsApp uses **XMPP's built-in presence features**, while Chatyy uses **WebSocket events + polling**. WhatsApp is more efficient, Chatyy is more flexible.

**Improvement Opportunity for Chatyy:**
```javascript
// Instead of 10s polling, use WebSocket presence push
// 1. Client sends presence_update on status change
// 2. Server broadcasts to all DM partners
// 3. Eliminates polling entirely
// 4. Reduces bandwidth 90%

// Current: 10s × 1000 users = 100 presence queries/10s
// New: 1 presence update per status change = 1 query
```

---

## PART 3: ENCRYPTION & MESSAGE FORMAT

### WhatsApp

**Protocol:** Signal Protocol (by Open Whisper Systems)

**Signal Protocol Details:**
- **Key Exchange**: X25519 Elliptic Curve Diffie-Hellman
- **Symmetric Encryption**: AES-256
- **Authentication**: HMAC-SHA256
- **Forward Secrecy**: New keys per message (Double Ratchet)
- **Post-Compromise Security**: Rebuilds keys even if one is compromised

**Message Format:**
```protobuf
// Protocol Buffers (Protobuf) serialization
message WhatsAppMessage {
  string messageKey;      // Unique message ID
  int64 timestamp;        // UTC timestamp
  bytes encryptedData;    // Signal-encrypted payload
  string senderJID;       // Sender phone number
  int32 fromMe;           // 0 = received, 1 = sent
  string status;          // 0=pending, 1=delivered, 2=read
}
```

**Flow:**
1. Message serialized to Protobuf
2. Serialized bytes encrypted with Signal Protocol
3. Wrapped in XML stanza
4. Sent over XMPP
5. Recipient decrypts with Signal keys
6. Recipient deserializes Protobuf

**Why Protobuf?**
- Faster serialization than JSON
- Smaller payload (binary format)
- Strong schema enforcement
- Language-agnostic

---

### Chatyy

**Encryption:** NaCl (libsodium)

**NaCl Primitives:**
- **Key Exchange**: X25519 (same as Signal)
- **Symmetric Encryption**: XSalsa20 (stream cipher)
- **Authentication**: Poly1305 (AEAD - Authenticated Encryption with Associated Data)
- **Random**: `random_bytes(16)` for nonces

**Message Format:**
```json
// JSON serialization (human-readable, larger)
{
  "id": "msg_123",
  "conversationId": "conv_456",
  "senderEmail": "user@example.com",
  "content": "Hello",
  "type": "text",
  "createdAt": "2026-04-08T12:34:56Z",
  "reactions": [
    {"emoji": "👍", "email": "user2@example.com"},
    {"emoji": "❤️", "email": "user3@example.com"}
  ],
  "mentions": ["@user2", "@user3"],
  "replyToId": null
}
```

**E2EE Lifecycle** (`services/e2ee.js`):
```javascript
// 1. Initialize (per device)
const { identity, prekeys } = e2ee.initialize(email);
// Register identity + batch of prekeys with server

// 2. Get conversation keys
const keys = await e2ee.getConversationKeys(conversationId, members);
// Fetch public keys for each member
// Establish shared secrets

// 3. Encrypt message
const encrypted = e2ee.encryptMessage(content, keys);
// Uses Double Ratchet for forward secrecy

// 4. Send
api.chatSend(conversationId, encrypted);

// 5. Decrypt (recipient)
const decrypted = e2ee.decryptMessage(encrypted, keys);
```

---

### COMPARISON

| Aspect | WhatsApp | Chatyy |
|--------|----------|--------|
| **Key Exchange** | X25519 | X25519 |
| **Encryption** | AES-256 | XSalsa20 |
| **Authentication** | HMAC-SHA256 | Poly1305 AEAD |
| **Forward Secrecy** | Double Ratchet | Double Ratchet |
| **Serialization** | Protobuf (binary) | JSON (text) |
| **Default E2EE** | Always | Opt-in |
| **Backward Compat** | Built-in | Manual handling |
| **Message Size** | Smaller (Protobuf) | Larger (JSON) |
| **Speed** | Faster deserialization | Slower (JSON parse) |

**Key Insight:** Both use **Signal-like Double Ratchet**, but WhatsApp uses **Protobuf (smaller/faster)** while Chatyy uses **JSON (flexible)**.

**Improvement Opportunities for Chatyy:**
1. **Switch to Protobuf serialization** (10-20% message size reduction)
2. **Make E2EE default** (not opt-in) for privacy parity
3. **Implement message key rotation** (WhatsApp rotates per message)

---

## PART 4: OFFLINE HANDLING & SYNC STRATEGY

### WhatsApp

**Strategy:** "Fetch after reconnect"

```
User offline:
  1. Client closes WebSocket
  2. Messages queued in Mnesia on server
  3. Push notifications sent via FCM/APNs (if enabled)
  
User comes back online:
  1. Client reconnects to WebSocket
  2. Sends presence_available
  3. Server sends all queued messages from Mnesia
  4. Client renders messages
```

**Recovery:**
- Messages kept in Mnesia until ACK received
- ACK sent when client confirms receipt
- No need for full sync (all messages sent immediately on reconnect)

**Push Notifications:**
- FCM (Android) / APNs (iOS)
- Triggered when user offline + new message
- Retry mechanism: Exponential backoff (1s, 2s, 4s, 8s, etc.)
- Max retry: 60 minutes (then give up)

---

### Chatyy

**Strategy:** "Delta sync with fallback"

```
User offline:
  1. Client WebSocket closes
  2. Messages inserted into PostgreSQL
  3. Pending message stored in device SQLite/MMKV
  4. Push notification sent (Firebase + Claude summary)
  
User comes back online:
  1. Client reconnects to WebSocket
  2. Calls chatSync(lastSeq, limit)
  3. Server queries: WHERE seq > lastSeq
  4. Client fetches paginated messages
  5. Catches up with delta sync
```

**Recovery** (`chatSync()` API):
```sql
-- Server-side delta query
SELECT * FROM chat_messages 
WHERE conversation_id = ? AND id > ? 
ORDER BY id ASC 
LIMIT ?
```

**Offline Queue:**
```javascript
// Device-side pending messages
const pending = [
  {
    id: 'local_1',
    conversationId: 'conv_123',
    content: 'Hello',
    clientMessageId: 'client_uuid_1',
    status: 'pending'
  }
];

// On reconnect:
for (const msg of pending) {
  try {
    await api.chatSend(msg.conversationId, msg.content, 
                       { clientMessageId: msg.clientMessageId });
    removePending(msg.id);
  } catch (e) {
    // Retry on next reconnect
  }
}
```

**Push Notifications:**
- Firebase Cloud Messaging
- AI-generated summary (Claude Haiku, 60 chars Portuguese)
- Grouping: Multiple messages grouped into 1 notification
- Retry: Firebase's built-in retry (doesn't expose to client)

---

### COMPARISON

| Aspect | WhatsApp | Chatyy |
|--------|----------|--------|
| **Offline Storage** | Mnesia (server) | PG (server) + SQLite (device) |
| **Recovery Strategy** | Server sends all queued | Client requests delta (pulls) |
| **Push Notifications** | FCM/APNs (simple) | Firebase + AI summaries |
| **Sync Method** | Server push on reconnect | Client pull (chatSync API) |
| **Pending Queue Location** | Server (Mnesia) | Device (SQLite/MMKV) |
| **Retry Logic** | Server-side auto-queue | Device-side pending queue |
| **ACK Flow** | Server ACK → Mnesia delete | PG row update status |
| **Message TTL** | Until ACK | Forever (PG) |
| **Catch-up Speed** | All messages pushed (fast) | Delta query (slower for large gaps) |

**Key Insight:** WhatsApp **server-pushes** all queued messages (lower latency), while Chatyy **client-pulls** (more scalable, but higher perceived latency).

**Improvement for Chatyy:**
```javascript
// Instead of delta sync (client pull):
// Implement server-push approach:

// 1. On reconnect, server immediately sends
//    all messages since last ACK'd message
ws.on('presence_available', (email) => {
  const messages = db.query(
    `SELECT * FROM messages 
     WHERE recipient = ? AND seq > ? 
     ORDER BY seq ASC`,
    [email, user.lastAckdSeq]
  );
  
  // Push to client immediately
  ws.send({ event: 'message_batch', messages });
  
  // Client doesn't need to ask, it gets pushed
});

// Benefit: 
// - Faster recovery (no extra round-trip)
// - Server controls flow
// - Same UX as WhatsApp
```

---

## PART 5: CALL SIGNALING INFRASTRUCTURE

### WhatsApp

**Signaling:** Proprietary protocol over modified XMPP

```
Caller initiates 1-on-1 voice call:

1. Caller connects to XMPP server
2. Server routes call request to Callee
3. Callee receives notification
4. If Callee accepts:
   - Callee sends acceptance signal
   - Both peers get STUN/TURN server addresses
   - P2P connection established via WebRTC
5. Call proceeds over P2P (encrypted)
6. Hangup signal sent via XMPP
```

**Group Calls:**
- Signaling: XMPP (who joins/leaves)
- Media: Centralized server (SFU - Selective Forwarding Unit)
- Participants: Up to 32
- Bandwidth: Server relays media streams

**Key Features:**
- STUN/TURN servers for NAT traversal
- Codec: Opus (audio), VP9 (video)
- Encryption: DTLS-SRTP (encrypted media path)
- Quality: Bandwidth detection, auto-bitrate adjust

---

### Chatyy

**Signaling:** WebSocket + WebRTC

```
Caller initiates 1-on-1 video call:

1. Caller sends WS message: { event: 'call_initiate', ... }
2. WS server routes to Callee via presence
3. Callee hears ringtone (Vibration API / Web Audio)
4. Callee accepts (sends WS ACK)
5. Caller receives acceptance
6. Both create RTCPeerConnection
7. Caller creates SDP offer:
   - a=setup:actpass (for WhatsApp API compat)
8. Exchange offer/answer via WebSocket
9. Exchange ICE candidates
10. Media streams flow P2P
```

**Code Flow** (`app/call.js`):
```javascript
// Caller side:
const peerConnection = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
});

// Add audio/video tracks
const offer = await peerConnection.createOffer();
await peerConnection.setLocalDescription(offer);

// Send via WebSocket
ws.send({ event: 'call_offer', offer });

// Receive answer
ws.on('call_answer', async (answer) => {
  await peerConnection.setRemoteDescription(answer);
});

// ICE candidates
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    ws.send({ event: 'ice_candidate', candidate: event.candidate });
  }
};
```

**Group Calls** (LiveKit):
```
Caller initiates group call:
  → API: chatGroupCall(conversationId, 'video')
  → Returns LiveKit room token + server URL
  → All participants connect to LiveKit SFU
  → Media relayed through SFU server
  → Max participants: Depends on LiveKit tier
```

---

### COMPARISON

| Aspect | WhatsApp | Chatyy |
|--------|----------|--------|
| **Signaling Protocol** | Proprietary XMPP | WebSocket (standard) |
| **P2P Negotiation** | Proprietary | WebRTC SDP offer/answer |
| **ICE Servers** | WhatsApp STUN/TURN | Google + custom STUN |
| **Media Codec Audio** | Opus (proprietary tuning) | Opus (standard) |
| **Media Codec Video** | VP9 (WhatsApp optimized) | VP8/H.264 (standard) |
| **Encryption** | DTLS-SRTP | DTLS-SRTP (via WebRTC) |
| **1-on-1 P2P** | Direct P2P | Direct P2P via WebRTC |
| **Group Calls** | SFU (proprietary) | LiveKit SFU |
| **Max Group Size** | 32 participants | LiveKit default (often 100+) |
| **Connection Quality** | Real-time tuning | WebRTC bandwidth adaptation |
| **Fallback Network** | Proprietary | TURN relay if P2P fails |

**Key Insight:** Both use **P2P for 1-on-1** (efficient), both use **SFU for groups** (scalable). WhatsApp is proprietary (closed), Chatyy uses standard WebRTC (open).

**Improvements for Chatyy:**
1. **Verify SDP setup attribute**: Ensure `a=setup:active` in answers (WhatsApp compat)
2. **Add speaker spotlight**: Detect loudest participant, highlight in UI
3. **Implement hand raising**: WebRTC data channel for "I have a question"
4. **Add call recording**: Record via MediaRecorder API
5. **Optimize codec choice**: Use Opus consistently, negotiate VP9 support

---

## PART 6: SCALING & PERFORMANCE PATTERNS

### WhatsApp's Scaling Strategy

**Architecture Pattern:** Vertical scaling with Erlang

```
1 Erlang Server:
  - 2-3 million concurrent connections
  - Each connection = lightweight process (Erlang)
  - Memory per connection: ~1KB
  - No threads, no connection pools

Server Farm:
  - 10 servers = 20-30 million concurrent users online simultaneously
  - Replication: Mnesia replicates across servers
  - Failover: If server crashes, connections auto-migrate
  - Message queue: Survives server restart (persisted in Mnesia)
```

**Why Erlang excels:**
- Lightweight processes: Overhead is microseconds
- No lock contention: Message passing instead of shared memory
- Hot reload: Code updates without restart
- Fault tolerance: "Let it crash" philosophy

**Bottleneck:** Database (Mnesia)
- In-memory: Fast writes/reads
- Replication: Network I/O becomes limiting factor
- Solution: Consistent hashing for data partitioning

---

### Chatyy's Scaling Strategy

**Architecture Pattern:** Horizontal scaling with Node.js

```
Load Balancer (NGINX)
  ↓
Node.js Worker 1 (port 3000)
Node.js Worker 2 (port 3001)
Node.js Worker 3 (port 3002)
...
  ↓
PostgreSQL (Primary)
PostgreSQL Replicas (Read-only)
  ↓
Redis Cache (single or cluster)
  ↓
MQTT Broker Cluster
```

**Concurrency Model:**
- Single-threaded event loop per Node.js process
- Horizontal scaling via clustering (pm2, Docker Compose)
- Connection pooling: 10 WebSocket workers
- Non-blocking I/O: All DB queries async

**Bottlenecks:**
1. PostgreSQL write throughput (mitigated by Redis cache)
2. MQTT broker load (mitigated by QoS 1 + persistence)
3. WebSocket server memory (each connection ~10KB RAM)

**Scaling Limits:**
- Single Node.js process: ~10k concurrent connections
- 100 processes: ~1M concurrent connections (more than Chatyy needs)

**Advantage over WhatsApp:** Can scale horizontally (add more servers) without rearchitecting.

---

### COMPARISON

| Aspect | WhatsApp | Chatyy |
|--------|----------|--------|
| **Primary Language** | Erlang | Node.js |
| **Concurrency Model** | Lightweight processes | Event loop + async/await |
| **Scaling Direction** | Vertical (bigger servers) | Horizontal (more servers) |
| **Connections per Server** | 2-3M | 10k-100k |
| **Memory per Connection** | ~1KB | ~10KB |
| **Database** | Mnesia (in-memory) | PostgreSQL (disk-based) |
| **Replication** | Mnesia replication | PG replication |
| **Failure Recovery** | Automatic (Erlang) | Manual (pm2/Docker) |
| **Code Updates** | Hot reload (no downtime) | Restart required |
| **Load Balancing** | Hash-based (Mnesia) | Round-robin (NGINX) |
| **Peak Throughput** | Millions msg/sec | Thousands msg/sec (per node) |

**Key Insight:** WhatsApp optimizes for **extreme concurrency on fewer servers** (expensive hardware). Chatyy optimizes for **cost-effective scale-out** (commodity servers).

---

## PART 7: RATE LIMITING & ANTI-SPAM

### WhatsApp Business API

**Rate Limiting Tiers:**

```
Throughput:
  - Default: 80 messages/second
  - Upgraded: Up to 1,000 msg/sec
  
Daily Limits (per business number):
  - Default: 250 unique recipients/day
  - Verified business: 1,000+ recipients/day
  
Frequency Capping:
  - Max ~2 marketing messages per person per day
  - Across ALL brands combined
  - Prevents user spam fatigue
  
Quality Rating:
  - Based on user feedback (reports, blocks)
  - Low rating → throttled
  - High rating → higher limits
```

**Retry Strategy:**
- 400, 401, 403, 404: Abort (don't retry)
- 429: Retry after Retry-After header (default 60s)
- 500: Exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, ...)
- Max retry: 60 minutes, then give up

---

### Chatyy

**No explicit rate limiting in codebase**, but should implement:

```javascript
// Recommended rate limiting per user:

const rateLimiter = {
  // Per conversation
  messagesPerSecond: 10,     // 10 msg/sec max
  messagesPerHour: 1000,     // 1000 msg/hour max
  
  // Per user
  conversationsPerMinute: 5, // New conv limit
  groupsPerDay: 50,          // New groups limit
  
  // File uploads
  filesPerDay: 100,
  maxFileSize: 100 * 1024 * 1024, // 100MB
  
  // Calls
  callsPerHour: 50,
  groupCallsPerDay: 10,
  
  // Database impact
  searchQueriesPerMinute: 10,
  dbWritesPerSecond: 100,
};

// Implementation:
const bucket = new TokenBucket(rate, capacity);
if (!bucket.take(1)) {
  return 429; // Too many requests
}
```

**Redis-backed rate limiter:**
```javascript
// INCR key per interval window
// If value > limit, reject with 429

const checkRateLimit = async (userId, action, limit, window) => {
  const key = `ratelimit:${userId}:${action}`;
  const count = await redis.incr(key);
  
  if (count === 1) {
    // First request in window, set expiry
    await redis.expire(key, window);
  }
  
  if (count > limit) {
    return { allowed: false, retryAfter: await redis.ttl(key) };
  }
  
  return { allowed: true };
};
```

---

## PART 8: IMPLEMENTATION RECOMMENDATIONS FOR CHATYY

### HIGH PRIORITY (Architectural)

**1. Switch to server-push model for message delivery**
```
Current: Client polls via chatSync() → Delta query
Proposed: Server sends all queued messages on reconnect

Benefit:
  - Lower perceived latency
  - Eliminates unnecessary API calls
  - Matches WhatsApp UX
  
Implementation:
  - On 'presence_available' event, push all messages
  - Replace chatSync() with server-driven delivery
  - Keep chatSync() for initial catch-up only
```

**2. Implement Protobuf serialization**
```
Current: JSON (larger messages, slower parsing)
Proposed: Protocol Buffers (binary format)

Benefit:
  - 10-20% message size reduction
  - Faster serialization/deserialization
  - Strong schema enforcement
  
Trade-off:
  - Binary format (less human-readable in debug)
  - Need .proto schema files
  
Recommendation: Start with JSON for new messages, add Protobuf later
```

**3. Make E2EE default (not opt-in)**
```
Current: Optional E2EE
Proposed: Always-on E2EE

Benefit:
  - Privacy parity with WhatsApp
  - Simpler user experience
  - Regulatory compliance (GDPR, etc)
  
Implementation:
  - Auto-enable E2EE for all new conversations
  - Migrate existing conversations gradually
  - UI: Show encryption badge on all chats
```

**4. Implement presence push (not polling)**
```
Current: 10s polling interval
Proposed: WebSocket presence events

Benefit:
  - Real-time presence (not 10s delayed)
  - 90%+ bandwidth reduction
  - Better UX (instant "online" status)
  
Implementation:
  const handlePresenceChange = (email, status) => {
    ws.broadcast(`presence_update`, { email, status });
  };
  
  // Broadcast to all DM partners of this user
  ws.on('presence_update', ({ email, status }) => {
    updateUI(email, status); // Instant update
  });
```

### MEDIUM PRIORITY (Features)

**5. Implement screen sharing for calls**
```
// Use getDisplayMedia API
const displayStream = await navigator.mediaDevices.getDisplayMedia();
peerConnection.addTrack(displayStream.getTracks()[0]);

// Signal to peer that screen is being shared
ws.send({ event: 'screen_share_start' });
```

**6. Add message spoiler/hidden text**
```
// Wrap text in spoiler tag
const spoiler = `<spoiler>${text}</spoiler>`;

// UI: Render as hidden (blur or redacted)
// On click/tap: Reveal text
// Implementation: CSS filter or custom component
```

**7. Implement hand raising for group calls**
```
// WebRTC data channel for signaling
peerConnection.createDataChannel('control');

// Send hand raise
controlChannel.send({ action: 'raise_hand', userId });

// UI: Show raised hands list, notify others
```

**8. Add speaker spotlight**
```
// Detect active speaker (highest volume)
const audioContext = new AudioContext();
const analyser = audioContext.createAnalyser();
const dataArray = new Uint8Array(analyser.frequencyBinCount);

// Update UI to show speaker in main tile
if (volume > threshold) {
  setMainSpeaker(userId);
}
```

### LOW PRIORITY (Polish)

**9. Add rate limiting per user**
```
// Prevent spam/abuse
const rateLimiter = new RateLimiter({
  messagesPerSecond: 10,
  uploadPerDay: 100,
  callsPerHour: 50
});

// Check on every action
if (!rateLimiter.allow(userId, action)) {
  return 429;
}
```

**10. Implement message edit time limit**
```
// WhatsApp: 15 min limit
// Chatyy: Currently unlimited (security risk)

const canEditMessage = (message) => {
  const ageSeconds = (Date.now() - message.createdAt) / 1000;
  return ageSeconds < 15 * 60; // 15 minutes
};

// UI: Hide edit button after 15 min
// Backend: Reject edits after 15 min
```

---

## SUMMARY TABLE: Chatyy vs WhatsApp Technical Stack

| Component | WhatsApp | Chatyy | Priority |
|-----------|----------|--------|----------|
| **Message Delivery** | Mnesia (in-mem push) | PG + MQTT (store + pull) | HIGH - switch to push |
| **Real-time Transport** | XMPP | WebSocket | MEDIUM - optimize |
| **Presence** | Real-time push | 10s polling | HIGH - implement push |
| **Typing Indicators** | Event-driven XMPP | Debounced WS | MEDIUM - already good |
| **Encryption** | Signal + Protobuf | NaCl + JSON | MEDIUM - add Protobuf |
| **Encryption Default** | Always-on | Opt-in | HIGH - make default |
| **Offline Sync** | Fetch on reconnect | Delta sync | MEDIUM - add push fallback |
| **Calls** | Proprietary + WebRTC | WebRTC | LOW - add features (screen share, hand raise) |
| **Group Calls** | SFU (proprietary) | LiveKit (open) | LOW - LiveKit better |
| **Scalability** | Vertical (Erlang) | Horizontal (Node.js) | LOW - both work |
| **Rate Limiting** | Built-in (WhatsApp API) | Not implemented | MEDIUM - add |
| **Message Format** | Protobuf (binary) | JSON (text) | LOW - later |

---

## CONCLUSION

**Chatyy is architecturally solid** and uses modern, scalable patterns (PostgreSQL, Redis, Node.js). WhatsApp's architecture is optimized for **extreme concurrency** (Erlang) and **instant delivery** (Mnesia + XMPP).

**Top 3 improvements for Chatyy:**
1. **Switch E2EE to default** (privacy parity)
2. **Implement presence push** (real-time, not polling)
3. **Add server-push for messages** (lower latency, WhatsApp-like UX)

These changes would bring Chatyy **99%+ parity with WhatsApp's core UX**, while maintaining its **modern, scalable architecture advantage**.

---

## SOURCES

- [WhatsApp Architecture Deep Dive](https://getstream.io/blog/whatsapp-works/)
- [WhatsApp System Design - Medium](https://medium.com/@YodgorbekKomilo/the-system-design-of-whatsapp-for-android-behind-the-scenes-of-a-global-messaging-giant-c80175b18016)
- [How WhatsApp Handles 40 Billion Messages](https://blog.bytebytego.com/p/how-whatsapp-handles-40-billion-messages)
- [WhatsApp Ejabberd & Erlang](https://www.contus.com/blog/how-whatsapp-works-technically-and-how-to-build-an-app-similar-to-it/)
- [Signal Protocol Whitepaper](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf)
- [WebRTC Signaling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling)
- [FCM Rate Limiting & Retry](https://firebase.google.com/docs/cloud-messaging/scale-fcm)
- [Typing Indicators Real-time](https://medium.com/@ygsh0816/inside-whatsapps-real-time-infrastructure-the-magic-behind-online-and-typing-f9ac648fb2e7)
- [WhatsApp Media & CDN](https://medium.com/@YodgorbekKomilo/the-system-design-of-whatsapp-for-android-behind-the-scenes-of-a-global-messaging-giant-c80175b18016)
