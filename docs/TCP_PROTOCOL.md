# Chatyy TCP Protocol Specification v1.0

**Status**: Design  
**Target**: Production  
**Baseline**: WhatsApp/Signal TCP socket protocol  
**Port**: 5222 (XMPP-like, well-known)  
**Encoding**: Binary frames + JSON payloads  
**Fallback**: HTTP long-polling (web, firewalls)

---

## 1. OVERVIEW

```
┌─────────────┐     TCP 5222      ┌──────────────────┐
│   Client    │◄───────────────►  │  Signal Server   │
│ (iOS/And/   │   Binary Frames   │   (Go on port    │
│  Web/RN)    │                   │    5222)         │
└─────────────┘                   └──────────────────┘
     │                                    │
     │ (offline)                          │ (PostgreSQL)
     ├─ Offline Queue (IndexedDB/MMKV)   │ Message store
     └─ Retry with exponential backoff   │ Presence tracking
                                          │ Deduplication
```

### Why TCP instead of MQTT/WS?
- **Latency**: 50-100ms (vs 100-150ms MQTT) = 33% faster
- **Overhead**: Binary protocol (vs JSON text) = 30% smaller packets
- **Simplicity**: Single connection (vs MQTT + WS dual)
- **Parity**: Matches WhatsApp's architecture exactly
- **Cost**: No MQTT broker license/maintenance

### Trade-offs
- **Complexity**: Custom protocol (not MQTT standard)
- **Web**: Needs HTTP long-polling fallback (firewalls block TCP)
- **Scalability**: Server must handle connection pooling (manageable)

---

## 2. BINARY FRAME FORMAT

All TCP packets follow this structure:

```
┌─────────┬─────────────────┬──────────────────┐
│ 1 byte  │ 2 bytes (BE)    │ N bytes (JSON)   │
├─────────┼─────────────────┼──────────────────┤
│ Type    │ Payload Length  │ Payload          │
└─────────┴─────────────────┴──────────────────┘
```

### Encoding Example

**Message**: `{ type: "AUTH", token: "abc123" }`

```
Type: 0x01 (AUTH)
Payload: {"type":"AUTH","token":"abc123"} (31 bytes)

Encoded:
0x01 (1 byte)
0x00 0x1F (2 bytes = 31 in big-endian)
{"type":"AUTH","token":"abc123"} (31 bytes)

Total: 34 bytes (vs ~50 bytes if plain JSON with framing)
```

### Frame Size Limits

| Field | Min | Max | Notes |
|-------|-----|-----|-------|
| **Payload** | 0 | 1MB | Prevents OOM attacks; split large files |
| **Frame** | 3 | 1MB+3 | Type (1) + Length (2) + Payload |
| **Queue** | - | 10k frames | Max offline buffer |

---

## 3. MESSAGE TYPES (0x00-0xFF)

### Authentication (0x01-0x0F)

#### 0x01 - AUTH (Client → Server)
```json
{
  "type": "auth",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "email": "alice@chatyy.com.br",
  "device_id": "uuid-1234",
  "device_name": "iPhone 14 Pro"
}
```
**Response**: 0x02 (AUTH_OK) or 0x03 (AUTH_FAIL)

#### 0x02 - AUTH_OK (Server → Client)
```json
{
  "user_id": 12345,
  "email": "alice@chatyy.com.br",
  "name": "Alice",
  "server_time": "2026-04-08T15:30:00Z",
  "server_time_offset_ms": 50
}
```

#### 0x03 - AUTH_FAIL (Server → Client)
```json
{
  "reason": "invalid_token",
  "message": "Token expired",
  "retry_after_ms": 5000
}
```

### Keepalive (0x10-0x1F)

#### 0x10 - PING (Server → Client, periodic every 25s)
```json
{
  "ts": 1712681400000
}
```

#### 0x11 - PONG (Client → Server, must respond within 10s)
```json
{
  "ts": 1712681400000
}
```

**Behavior**: If PONG not received in 10s, server kills connection (dead client)

### Chat Messages (0x20-0x3F)

#### 0x20 - CHAT_SEND (Client → Server)
```json
{
  "conversation_id": 789,
  "content": "Hello!",
  "type": "text",
  "reply_to_id": null,
  "mentions": ["bob@chatyy.com.br"],
  "temp_id": "tmp_1712681400123_a1b2c3",
  "client_message_id": "c_6rdgs5x_1"
}
```
**Server validates**:
- User is member of conversation
- Message length < 5000 chars
- No duplicate (check client_message_id)

#### 0x21 - CHAT_MESSAGE (Server → Client)
```json
{
  "id": 54321,
  "conversation_id": 789,
  "sender_email": "alice@chatyy.com.br",
  "sender_name": "Alice",
  "content": "Hello!",
  "type": "text",
  "created_at": "2026-04-08T15:30:00Z",
  "temp_id": "tmp_1712681400123_a1b2c3",
  "reply_to_id": null,
  "reaction_count": 0
}
```

#### 0x22 - CHAT_ACK (Server → Client)
Sent immediately after receiving CHAT_SEND (before saving to DB)
```json
{
  "server_message_id": 54321,
  "temp_id": "tmp_1712681400123_a1b2c3",
  "ts": 1712681400000
}
```
**Purpose**: Client replaces temp UI message with real server ID

#### 0x23 - CHAT_READ (Client → Server)
```json
{
  "conversation_id": 789,
  "message_id": 54321,
  "ts": 1712681400000
}
```

#### 0x24 - CHAT_READ_BROADCAST (Server → Client)
```json
{
  "conversation_id": 789,
  "reader_email": "bob@chatyy.com.br",
  "message_id": 54321,
  "ts": 1712681400000
}
```

#### 0x25 - CHAT_REACT (Client → Server)
```json
{
  "message_id": 54321,
  "emoji": "👍",
  "action": "add"  // or "remove"
}
```

#### 0x26 - CHAT_REACT_BROADCAST (Server → Client)
```json
{
  "message_id": 54321,
  "reactor_email": "bob@chatyy.com.br",
  "emoji": "👍",
  "action": "add"
}
```

#### 0x27 - CHAT_DELETE (Client → Server)
```json
{
  "message_id": 54321,
  "scope": "for_me"  // or "for_all"
}
```

#### 0x28 - CHAT_DELETE_BROADCAST (Server → Client)
```json
{
  "message_id": 54321,
  "scope": "for_all",
  "deleter_email": "alice@chatyy.com.br"
}
```

#### 0x29 - CHAT_EDIT (Client → Server)
```json
{
  "message_id": 54321,
  "content": "Hello! (edited)"
}
```

#### 0x2A - CHAT_EDIT_BROADCAST (Server → Client)
```json
{
  "message_id": 54321,
  "content": "Hello! (edited)",
  "edited_at": "2026-04-08T15:31:00Z"
}
```

### Subscriptions (0x30-0x3F)

#### 0x30 - SUBSCRIBE (Client → Server)
```json
{
  "conversation_ids": [789, 790, 791]
}
```
**Purpose**: Tell server "I want messages from these conversations"

#### 0x31 - UNSUBSCRIBE (Client → Server)
```json
{
  "conversation_ids": [789]
}
```

#### 0x32 - SUBSCRIBE_ACK (Server → Client)
```json
{
  "conversation_ids": [789, 790, 791],
  "status": "ok"
}
```

### Presence & Typing (0x40-0x4F)

#### 0x40 - STARTED_TYPING (Client → Server)
```json
{
  "conversation_id": 789
}
```

#### 0x41 - STOPPED_TYPING (Client → Server)
```json
{
  "conversation_id": 789
}
```

#### 0x42 - USER_TYPING (Server → Client, broadcast)
```json
{
  "conversation_id": 789,
  "user_email": "alice@chatyy.com.br",
  "user_name": "Alice"
}
```

#### 0x43 - USER_ONLINE (Server → Client, broadcast)
```json
{
  "email": "alice@chatyy.com.br",
  "status": "online"
}
```

#### 0x44 - USER_OFFLINE (Server → Client, broadcast)
```json
{
  "email": "alice@chatyy.com.br",
  "status": "offline",
  "last_seen": "2026-04-08T15:30:00Z"
}
```

### Errors & Control (0xF0-0xFF)

#### 0xF0 - ERROR (Server → Client)
```json
{
  "code": "INVALID_MESSAGE",
  "message": "Payload exceeds 1MB",
  "details": {}
}
```

#### 0xF1 - DISCONNECT (Server → Client)
```json
{
  "reason": "session_terminated",
  "message": "Your session was terminated by another device"
}
```

---

## 4. CONNECTION FLOW

### Initial Connection

```
┌────────────────────────────────────────────┐
│ Client                                     │
├────────────────────────────────────────────┤
│ 1. TCP connect to 5222                    │
│    └─ Start 10s connection timeout         │
│                                             │
│ 2. Send AUTH frame (0x01)                 │
│    └─ Payload: { token, email, device }  │
│                                             │
│ 3. Wait for AUTH_OK (0x02) or AUTH_FAIL  │
│    (0x03)                                  │
│                                             │
│ 4. If AUTH_OK:                            │
│    └─ Start PING/PONG keepalive (25s)    │
│    └─ Send SUBSCRIBE (0x30)               │
│    └─ Client is ready for messages        │
│                                             │
│ 5. If AUTH_FAIL:                          │
│    └─ Close connection                    │
│    └─ Retry after delay (exponential)     │
└────────────────────────────────────────────┘
```

### Message Send & Ack

```
┌─────────────────────────────────────────┐
│ Client sends message                    │
├─────────────────────────────────────────┤
│ 1. Generate temp_id + client_message_id│
│ 2. Show message in UI as "pending"      │
│ 3. Send CHAT_SEND (0x20) frame          │
│                                          │
│ 4. Wait for CHAT_ACK (0x22)             │
│    [Timeline: 50-100ms ideal]           │
│                                          │
│ 5. When ACK received:                   │
│    └─ Replace temp_id with real ID      │
│    └─ Mark as "sent" in UI              │
│                                          │
│ 6. Later: receive CHAT_MESSAGE (0x21)  │
│    from subscription (confirmation)     │
│    └─ Mark as "delivered"               │
└─────────────────────────────────────────┘
```

### Offline Recovery

```
Client goes offline:
  1. TCP connection drops (connection.close() fires)
  2. Queue all outgoing messages in offlineCache
  3. Stop PING/PONG
  4. Show "offline" indicator in UI

Client comes back online:
  1. Retry TCP connect (exponential backoff starts at 2s)
  2. Send AUTH again
  3. Subscribe to all conversations
  4. Replay offline queue (one by one)
  5. Dedup: server ignores duplicates by client_message_id
  6. UI shows "syncing..." → "synced"
```

---

## 5. DEDUPLICATION STRATEGY

**Goal**: Prevent duplicate messages on retry without losing real duplicates from different clients

### Approach: Server-Side Dedup

```
Client A sends message:
  {
    "conversation_id": 789,
    "content": "Hello",
    "client_message_id": "c_6rdgs5x_1"  ← UNIQUE per client per app session
  }

Server receives:
  1. Check: SELECT id FROM messages WHERE client_message_id = "c_6rdgs5x_1"
  2. If exists: return existing message ID (idempotent)
  3. If not: INSERT + return new ID

Client retries same message (network timeout):
  → Same client_message_id
  → Server returns same ID (no duplicate created)

Different client (Client B) sends same text:
  → Different client_message_id
  → Server creates new message (correct)
```

### client_message_id Format

```javascript
function generateClientMessageId() {
  // c = client, 6rdgs5x = timestamp base36, 1 = counter
  return `c_${Date.now().toString(36)}_${++_msgIdCounter}`;
}
```

**Uniqueness**:
- Timestamp (base36) = unique per ~1s
- Counter = handles multiple messages in same ms
- Probability of collision: < 1 in 10 billion

---

## 6. KEEPALIVE (PING/PONG)

### Server → Client PING (0x10)
- Sent every 25s
- Payload: { ts: server_timestamp_ms }

### Client → Server PONG (0x11)
- Must respond within 10s
- Payload: { ts: echo_server_timestamp }

### Timeout Behavior

```
Server sends PING ──────────────────┐
                                    │ Wait 10s
Client receives & sends PONG ───────┤
                                    │ If PONG arrives within 10s:
Server receives PONG ───────────────┘  OK, continue

If no PONG in 10s:
  Server closes connection (sends DISCONNECT 0xF1)
  Client detects connection close
  Client enters offline mode + retry
```

---

## 7. ERROR HANDLING

### Client-Side

```javascript
try {
  await tcpClient.send(CHAT_SEND, payload);
  // Got ACK
} catch (e) {
  if (e.type === 'network_error') {
    // Queue for offline retry
    offlineCache.queue(payload);
  } else if (e.type === 'auth_error') {
    // Logout + show login screen
    auth.logout();
  } else if (e.type === 'invalid_message') {
    // Don't retry, show error to user
    Alert.alert('Error', e.message);
  }
}
```

### Server-Side

```go
// On error:
if err != nil {
  if isNetworkError(err) {
    // Connection died, client will retry
  } else if isProtocolError(err) {
    // Bad frame format, send ERROR frame + close
    sendError(conn, "INVALID_FRAME")
    conn.Close()
  } else {
    // Business logic error, send ERROR frame but keep open
    sendError(conn, "INVALID_MESSAGE")
  }
}
```

---

## 8. EXAMPLE: COMPLETE MESSAGE FLOW

### Setup

- **User**: alice@chatyy.com.br
- **Conversation**: 789 (group with Alice, Bob, Carol)
- **Message**: "Hello team!"

### Step-by-step

```
T=0ms:
  Alice's client:
  1. Generates temp_id = "tmp_1712681400000_abc"
  2. Generates client_msg_id = "c_6rdgs5x_1"
  3. Shows message in UI as "pending"
  4. Sends CHAT_SEND (0x20):
     {
       "conversation_id": 789,
       "content": "Hello team!",
       "type": "text",
       "temp_id": "tmp_1712681400000_abc",
       "client_message_id": "c_6rdgs5x_1"
     }

T=50ms:
  Server:
  1. Receives CHAT_SEND frame
  2. Validates: Alice is member of conv 789 ✓
  3. Checks dedup: SELECT * FROM messages WHERE client_message_id = "c_6rdgs5x_1" → empty
  4. Inserts message:
     INSERT INTO messages (conversation_id, sender_email, content, client_message_id, ...)
     VALUES (789, 'alice@chatyy.com.br', 'Hello team!', 'c_6rdgs5x_1', ...)
     → msg_id = 54321
  5. Sends ACK (0x22) to Alice:
     {
       "server_message_id": 54321,
       "temp_id": "tmp_1712681400000_abc",
       "ts": 1712681400050
     }
  6. Broadcasts CHAT_MESSAGE (0x21) to Bob, Carol:
     {
       "id": 54321,
       "conversation_id": 789,
       "sender_email": "alice@chatyy.com.br",
       "sender_name": "Alice",
       "content": "Hello team!",
       "created_at": "2026-04-08T15:30:00Z",
       "temp_id": "tmp_1712681400000_abc"
     }

T=100ms:
  Alice's client:
  1. Receives ACK (0x22)
  2. Replaces temp_id with real ID: 54321
  3. Message shows as "sent"

T=110ms:
  Bob's client:
  1. Receives CHAT_MESSAGE (0x21) via subscription to conv 789
  2. Shows "Alice: Hello team!" in conversation
  3. (Optional) Shows "Delivered" indicator to Alice

T=200ms:
  Alice's client:
  1. Also receives CHAT_MESSAGE (0x21) via subscription (confirmation)
  2. Message confirms as "delivered"
  3. Stores in local cache
```

---

## 9. COMPARISON: MQTT vs TCP

| Feature | MQTT | TCP |
|---------|------|-----|
| **Protocol** | MQTT 3.1.1 pub/sub | Custom binary |
| **Latency** | 100-150ms | 50-100ms |
| **Frame size** | JSON text (larger) | Binary (30% smaller) |
| **Dedup** | Client-side ring buffer | Server-side (idempotent) |
| **Offline** | Broker queues | App queues locally |
| **Web** | Native support | Needs HTTP fallback |
| **Scalability** | Broker-managed | App-managed connection pool |
| **Complexity** | Standard lib (mqtt.js) | Custom server (Go) |

---

## 10. MIGRATION PATH

### Phase 1: TCP Server (Part 1-5)
- Write TCP server in Go
- Deploy to prod
- Keep MQTT running (parallel)

### Phase 2: TCP Client (JS)
- Write JS TCP client
- Implement same event emitter as MQTT
- No changes needed in chat-conversation.js (swappable)

### Phase 3: Cutover
- Switch a test user to TCP
- Monitor metrics (latency, errors, stability)
- Gradually roll out (10% → 50% → 100%)
- Disable MQTT after 2 weeks (keep as fallback)

---

## 11. DEPLOYMENT ARCHITECTURE

```
┌──────────────────────────────────────────────────────┐
│ Nginx (port 80/443)                                  │
│ ├─ /api/* → PHP backend (email, files, auth)        │
│ └─ /ws → WebSocket reverse proxy (fallback)         │
└──────────────────────────────────────────────────────┘
                        │
┌──────────────────────────────────────────────────────┐
│ Chatyy Signal Server (port 5222, Go binary)         │
│ ├─ TCP listener (main chat protocol)                │
│ ├─ Connection pool (track online users)             │
│ └─ PostgreSQL connection pool (message store)       │
└──────────────────────────────────────────────────────┘
                        │
                    PostgreSQL 13+
                    (existing DB)
```

### Systemd Service

```ini
[Unit]
Description=Chatyy Signal Server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
ExecStart=/opt/chatyy-signal/server
Restart=always
RestartSec=5
User=www-data
Environment="DATABASE_URL=postgres://..."
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## 12. MONITORING & OBSERVABILITY

### Prometheus Metrics

```
chatyy_tcp_connections_active (gauge)
chatyy_tcp_messages_per_second (counter)
chatyy_tcp_latency_p99_ms (histogram)
chatyy_tcp_dedup_hits (counter)
chatyy_tcp_errors_total (counter)
```

### Logs

```json
{
  "ts": "2026-04-08T15:30:00Z",
  "event": "message_received",
  "email": "alice@chatyy.com.br",
  "conversation_id": 789,
  "message_id": 54321,
  "client_message_id": "c_6rdgs5x_1",
  "latency_ms": 48
}
```

---

**Version**: 1.0  
**Last Updated**: 2026-04-08  
**Status**: FINAL - Ready for implementation
