# 03 — Binary Signaling Protocol (CWP/1)

**Agent 3 / 10 — WhatsApp Migration**
**Status:** Design proposal. No production code touched.
**Inspiration:** WhatsApp FunXMPP (binary-encoded XMPP).
**Replaces:** JSON-over-WebSocket text frames in `/opt/chatyy-ws-cpp/src/main.cpp`.

---

## 1. Motivation

The 2026-05-19 `call_invite` / `call_end` regression was a *parsing* failure: clients sent `{"type":"call_end", "data":{...}}` while server expected legacy flat shape, or vice-versa. JSON's structural laxity — string-typed `type`, optional nested `data`, divergent Android/iOS spellings (`call_answered` vs `call_accepted`) — let the bug ship silently for days.

A binary, schema-first wire protocol with a compile-time-checked opcode + TLV layout makes the same class of bug a compile error on both sides, and cuts call-signaling bandwidth ~70% versus JSON.

Name: **CWP/1** — *Chatyy Wire Protocol, version 1*.

---

## 2. Frame Format

All multi-byte integers are **big-endian** (network order). Frames live inside WebSocket **BINARY** frames (opcode 0x2). One CWP frame per WS frame.

### 2.1 Fixed header (8 bytes)

```
 0               1               2               3
 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  MAGIC (0xC7)  |   VER (0x01)  |     FLAGS     |   OPCODE      |
+---------------+---------------+---------------+---------------+
|                         PAYLOAD_LEN (uint32)                   |
+---------------+---------------+---------------+---------------+
|                         TLV payload ...                        |
```

- **MAGIC** `0xC7` — sanity byte; reject otherwise. Lets a hybrid `onMessage` distinguish CWP from a `{` JSON byte.
- **VER** `0x01` — bumped for breaking changes. Server advertises supported range in `HELLO`.
- **FLAGS** bit-packed:
  - `0x01` COMPRESSED (Snappy frame format)
  - `0x02` ENCRYPTED (Noise-wrapped — reserved, see Agent 5)
  - `0x04` REQ_ACK (server must echo ACK with matching `req_id`)
  - `0x08` FRAGMENT (more frames follow with same `seq`)
- **OPCODE** — see §3.
- **PAYLOAD_LEN** uint32, max `2^20` (1 MiB hard cap; signaling frames target <500 B).

### 2.2 TLV body

The payload is a flat sequence of TLV triplets:

```
+---------+---------+----------------+
|  TAG    | LENTYPE |   VALUE        |
| (1 B)   | (1-3 B) |   variable     |
+---------+---------+----------------+
```

- **TAG** — 1 byte field-id, per-opcode namespace (see §3).
- **LENTYPE** — top 2 bits select length encoding:
  - `00xxxxxx` — 6-bit length (0–63) inline
  - `01xxxxxx xxxxxxxx` — 14-bit length (0–16383)
  - `10000000` + uint32 — 4-byte big-endian length (large fields)
  - `11ttttttt` — typed scalar shortcuts (uint8/uint16/uint32/uint64/bool/null) — no separate length

This mirrors FunXMPP's dictionary-token trick but keeps it self-describing — no shared dict needed on first connect.

### 2.3 Maximum frame budget

A `CALL_INVITE` carries: caller_id (16 B UUID), callee_id (16 B), room_id (16 B), call_type (1 B), is_video (1 B), sdp_offer (~300 B), ts (8 B). Header + TLV overhead ≈ 30 B. Total **~380 B** vs current JSON ~720 B → **47% smaller** uncompressed, **~70%** with Snappy on the SDP.

---

## 3. Opcode Catalog

Opcodes are namespaced by high nibble.

| Opcode | Hex | Direction | Purpose |
|---|---|---|---|
| `HELLO` | `0x01` | C→S | First frame; carries proto version, client build, capabilities |
| `WELCOME` | `0x02` | S→C | Accepts session, returns server caps + heartbeat interval |
| `AUTH` | `0x03` | C→S | Bearer token (see §7) |
| `AUTH_OK` | `0x04` | S→C | Session established, returns canonical user_id |
| `AUTH_FAIL` | `0x05` | S→C | Code + reason |
| `PING` | `0x06` | both | Keepalive (see §8) |
| `PONG` | `0x07` | both | Keepalive reply |
| `ACK` | `0x08` | both | Echoes `req_id` when REQ_ACK set |
| `ERROR` | `0x09` | S→C | Protocol-level error (bad opcode, schema violation) |
| `PRESENCE` | `0x10` | both | online / away / typing |
| `CALL_INVITE` | `0x20` | C→S→C | Initiate call (caller, callee, room, type) |
| `CALL_RING` | `0x21` | S→C | Server-issued ring acknowledgement (transit confirmed) |
| `CALL_ANSWER` | `0x22` | C→S→C | Callee accepted (unifies android `call_answered` + ios `call_accepted`) |
| `CALL_DECLINE` | `0x23` | C→S→C | Callee declined |
| `CALL_CANCEL` | `0x24` | C→S→C | Caller cancels before pickup |
| `CALL_END` | `0x25` | C→S→C | Hang up |
| `CALL_BUSY` | `0x26` | S→C | Callee already in call |
| `RELAY_OFFER` | `0x30` | C→S→C | SDP offer (LiveKit-bypass relay path) |
| `RELAY_ANSWER` | `0x31` | C→S→C | SDP answer |
| `ICE_CANDIDATE` | `0x32` | C→S→C | Trickle ICE |
| `MEDIA_DATA` | `0x40` | C→S→C | SFU-bypass small media payload (DTMF, mic level) — uses FRAGMENT bit for >1 MiB |
| `LIVE_COHOST_INVITE` | `0x50` | both | Live co-host flow (Agent-3 base, §6 in MEMORY) |
| `LIVE_COHOST_APPROVED` | `0x51` | S→C | |
| `KICK` | `0xF0` | S→C | Server-initiated session termination |
| `GOODBYE` | `0xFF` | both | Clean close |

Field tags (per-opcode) are versioned via VER — adding a new tag is backwards-compatible if old peers ignore unknown tags (rule: **`MUST_IGNORE_UNKNOWN`** unless tag has high bit set — then it's `MUST_UNDERSTAND` and a missing decoder rejects the frame).

### 3.1 Example: `CALL_INVITE` field tags

| Tag | Type | Name | Required |
|---|---|---|---|
| `0x01` | UUID (16 B) | caller_id | Y |
| `0x02` | UUID (16 B) | callee_id | Y |
| `0x03` | UUID (16 B) | room_id | Y |
| `0x04` | uint8 | call_type (1=audio, 2=video) | Y |
| `0x05` | uint64 | ts_ms | Y |
| `0x06` | bytes | sdp_offer (Snappy-compressed if FLAGS.COMPRESSED) | N |
| `0x07` | string | caller_display_name | N |
| `0x08` | bytes | caller_avatar_url | N |

---

## 4. Migration Path (JSON → Binary)

**30-day dual-stack window.** The C++ WS already branches on `uWS::OpCode`:

```cpp
if (op == uWS::OpCode::TEXT)   handle_json(msg);
if (op == uWS::OpCode::BINARY) handle_cwp(msg);
```

Phase plan:

1. **D+0:** Ship `handle_cwp` parser behind `CWP_ENABLE=1` env. JSON path untouched.
2. **D+0:** Native clients (iOS/Android) gain `CWPClient` alongside existing `WSClient`. Negotiated via WS Sec-WebSocket-Protocol subprotocol: `cwp.1` advertised; fall back to default if server doesn't echo it.
3. **D+7:** Web client (JS) gains CWP support via a `DataView` encoder (~400 LOC). JSON kept as fallback.
4. **D+14:** Server starts logging JSON frames by `client_build` — track adoption.
5. **D+30:** Cut JSON parser to read-only "deprecated" mode that returns `ERROR(0x09, code=DEPRECATED)` and triggers force-update prompt.
6. **D+45:** JSON path removed.

Shim layer maps CWP ↔ JSON during the window so the WS broadcast plane can stay heterogeneous: a CWP `CALL_INVITE` from new iOS is re-emitted as JSON to an old Android still on JSON.

---

## 5. Reference C++ Encoder/Decoder (server)

Pseudocode for libuv/uWS zero-copy path:

```cpp
// Decoder — operates on the uWS recv buffer in place
struct Frame { uint8_t ver, flags, op; uint32_t len;
               std::string_view body; };

std::optional<Frame> decode(std::string_view buf) {
    if (buf.size() < 8 || (uint8_t)buf[0] != 0xC7) return {};
    Frame f{(uint8_t)buf[1], (uint8_t)buf[2], (uint8_t)buf[3], 0, {}};
    f.len = be32(buf.data()+4);
    if (buf.size() < 8 + f.len) return {};        // need more bytes
    f.body = buf.substr(8, f.len);
    return f;
}

// TLV walker — does NOT allocate; yields views into recv buffer
template<class Fn>
void walk_tlv(std::string_view body, Fn&& cb) {
    size_t i = 0;
    while (i < body.size()) {
        uint8_t tag = body[i++];
        auto [len, hdr] = parse_lentype(body.substr(i));
        i += hdr;
        cb(tag, body.substr(i, len));   // std::string_view, zero-copy
        i += len;
    }
}

// Encoder — single contiguous buffer, no temporary copies
class FrameBuilder {
    std::string buf;
public:
    FrameBuilder(uint8_t op, uint8_t flags=0) {
        buf.reserve(256);
        buf.append({char(0xC7), 0x01, char(flags), char(op),
                    0,0,0,0});       // len placeholder
    }
    void add(uint8_t tag, std::string_view v) { /* TLV append */ }
    void add_u64(uint8_t tag, uint64_t v)     { /* typed scalar */ }
    std::string&& finish() {
        uint32_t l = buf.size() - 8;
        write_be32(buf.data()+4, l);
        return std::move(buf);
    }
};
```

Wire into `main.cpp`:

```cpp
ws->onMessage([](auto* ws, std::string_view msg, auto op) {
    if (op == uWS::OpCode::BINARY) {
        auto f = decode(msg);
        if (!f) { ws->close(1002, "bad_cwp"); return; }
        dispatch_cwp(ws, *f);
    } else {
        handle_json_legacy(ws, msg);   // existing path, untouched
    }
});
```

---

## 6. Reference Kotlin (Android) Encoder

```kotlin
class CwpFrame(val op: Byte, val flags: Byte = 0) {
    private val body = ByteArrayOutputStream(256)
    fun addUuid(tag: Byte, id: UUID) { /* 16 raw bytes */ }
    fun addU64(tag: Byte, v: Long)   { /* 0xC0 typed-scalar prefix */ }
    fun addBytes(tag: Byte, b: ByteArray) { /* len-prefixed */ }
    fun encode(): ByteArray {
        val payload = body.toByteArray()
        val out = ByteBuffer.allocate(8 + payload.size).order(BIG_ENDIAN)
        out.put(0xC7.toByte()).put(0x01).put(flags).put(op)
        out.putInt(payload.size)
        out.put(payload)
        return out.array()
    }
}

// Send a CALL_INVITE
val f = CwpFrame(op = 0x20).apply {
    addUuid(0x01, callerId)
    addUuid(0x02, calleeId)
    addUuid(0x03, roomId)
    addU8  (0x04, 2)              // video
    addU64 (0x05, System.currentTimeMillis())
    addBytes(0x06, snappy(sdp.toByteArray()))
}
webSocket.send(ByteString.of(*f.encode()))
```

## 6.1 Reference Swift (iOS) Decoder

```swift
struct CwpFrame {
    let op: UInt8
    let flags: UInt8
    let tlv: [UInt8: Data]   // tag -> value
}

func decode(_ data: Data) -> CwpFrame? {
    guard data.count >= 8, data[0] == 0xC7 else { return nil }
    let op = data[3]
    let flags = data[2]
    let len = UInt32(bigEndian: data[4..<8].withUnsafeBytes { $0.load(as: UInt32.self) })
    guard data.count >= 8 + Int(len) else { return nil }
    var tlv: [UInt8: Data] = [:]
    var i = 8
    while i < 8 + Int(len) {
        let tag = data[i]; i += 1
        let (vlen, hdr) = parseLenType(data, at: i); i += hdr
        tlv[tag] = data.subdata(in: i..<(i+vlen)); i += vlen
    }
    return CwpFrame(op: op, flags: flags, tlv: tlv)
}
```

---

## 7. Auth in Binary

After WS upgrade, client sends `HELLO` (unauthenticated) then `AUTH`:

```
AUTH frame, op=0x03
  TLV 0x01 = bearer_token (bytes, raw 32 B not hex)
  TLV 0x02 = device_id (UUID)
  TLV 0x03 = client_build (uint32)
  TLV 0x04 = platform (uint8: 1=ios,2=android,3=web)
```

Server validates against the same filesystem cache used today (`auth.cpp`); on success returns `AUTH_OK` with user_id + capability bitmap. The existing nginx-injected `?token=...` query param is **deprecated** in CWP — token only travels in the `AUTH` frame, never URL-logged.

---

## 8. Heartbeat

- Server in `WELCOME` advertises `heartbeat_interval_ms` (default 25 000).
- Either side sends `PING(0x06)` with TLV `0x01=nonce(uint64)`; peer replies `PONG(0x07)` echoing nonce + `0x02=server_ts_ms`.
- Two missed pings → close with code 1011.

This replaces the current 30 s WS ping behaviour in `main.cpp` with an in-protocol heartbeat that survives proxies stripping WS control frames.

---

## 9. Compression

- **Per-field Snappy** on SDP, ICE blobs, avatar URLs (anything >120 B). FLAGS.COMPRESSED set only when at least one field is compressed; per-field marker is encoded in the lentype dictionary.
- **Per-frame** compression rejected — overhead dominates for sub-500 B frames and complicates zero-copy parsing.
- WebSocket `permessage-deflate` **disabled** to avoid CRIME-class attacks and double-compression cost.

---

## 10. Compatibility Matrix

| Client / Server | Old JSON server | New dual-stack server | New CWP-only server (D+45) |
|---|---|---|---|
| Old JSON client | works | works (JSON path) | force-update via `ERROR(DEPRECATED)` |
| New dual client (JSON+CWP) | works (JSON) | works (CWP via subprotocol) | works (CWP) |
| New CWP-only client | fails | works | works |

Subprotocol negotiation guard: client always advertises `cwp.1, json.legacy`; server picks `cwp.1` if compiled with CWP, else `json.legacy`. Web JS keeps both encoders shipped during the 30-day window (~6 KB minified).

---

## 11. Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Endian / alignment bug on ARM32 (legacy Androids) | High — silent decode corruption | Force `ByteBuffer.order(BIG_ENDIAN)`; QA on Android 8 device farm |
| Snappy native lib missing on iOS old archs | Med | Ship `SwiftSnappy` SPM dep; fall back to uncompressed if unavailable |
| `permessage-deflate` left enabled by some CDN/proxy | Med | Send `Sec-WebSocket-Extensions: ` explicitly empty; assert in server |
| MUST_UNDERSTAND tag added in v1.1 breaks v1.0 clients | Med | Gate behind `VER` bump; server only emits to clients that sent VER>=1.1 in HELLO |
| Binary frames pass through logging pipeline that assumed UTF-8 | Low | Update `logf` in main.cpp to hex-dump non-text WS payloads |
| Replay attack of captured frames | Low (already TLS) | Future: integrate Noise (Agent 5) via FLAGS.ENCRYPTED |
| Schema drift between iOS/Android/server | The original bug | Generate codecs from one `.cwp` IDL file (proto-style) — single source of truth in `/cwp/schema.cwp` |

The **IDL-generated codec** is the structural fix for the 2026-05-19 envelope-wrap bug: there's no longer a string `"call_answered"` vs `"call_accepted"` to typo — both compile to opcode `0x22 CALL_ANSWER`, period.

---

## 12. Next Steps (out of scope for Agent 3)

- Agent 4: encryption layer (Noise XX) carried in FLAGS.ENCRYPTED.
- Agent 5: IDL compiler + CI check that schema.cwp diffs cause major-VER bump.
- Agent 7: load test CWP vs JSON at 10 k concurrent calls.
