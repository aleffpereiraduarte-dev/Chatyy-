# Chatyy WS Transport Upgrade Plan

**Status:** Design (no code shipped)
**Date:** 2026-05-19
**Author:** Eng research
**Scope:** `/opt/chatyy-ws-go/main.go` (gorilla/websocket, 3.7k LOC, 70+ event types) and JS clients (`services/websocket.js`, `services/sendWorker.js`, `services/tcp-client.js`).
**Goal:** WhatsApp-grade WS reliability + payload size without rebuilding the world.

---

## 0. Reality check

WhatsApp runs persistent TCP with a binary, schema-driven framing (Noise-encrypted, XMPP-stanza-derived). Not MQTT, not gRPC, not WebTransport. The wins come from binary payloads, 1-byte op codes, and app-level ACK+resume — not a new pipe.

`main.go` marshals `map[string]interface{}` via `json.Marshal` at 6 chokepoints. Typical envelope 200-800B; contact/thumbnail payloads 3-5KB. That is the cost.

---

## 1. Option matrix

| Option | Effort (dev-days) | Bytes saved | Latency saved | Reliability gain | LiveKit | nginx | Cloudflare |
|---|---|---|---|---|---|---|---|
| **A. Binary framing on WS** (MessagePack/Protobuf) | 8-12 | 50-65% (3.5KB→1.3KB) | 5-15ms RTT on slow links | None inherent (still need app ACK) | unaffected (separate transport) | unaffected (still ws://) | unaffected (already grey-cloud `ws.chatyy.com.br`) |
| **B. MQTT 5 over WS** (EMQX) | 25-40 | 30-40% (header only) | similar | QoS 1/2, retained, LWT, session resume | unaffected | broker proxied via nginx OK | Cloudflare WS proxy OK |
| **C. gRPC bidi streams** | 35-55 | 40-55% (proto + HPACK) | -5ms (HTTP/2 mux) | Per-stream cancel, deadlines | unaffected | nginx grpc_pass works | **CF strips trailers on free**, need Enterprise or origin direct |
| **D. WebTransport (H3/QUIC)** | 60-90+ | 35-50% | 20-50ms on lossy mobile (0-RTT resume) | Per-stream reliability, multipath | unaffected | nginx no native H3 yet | CF supports H3 but no WT proxying yet (mid-2026) |

### A — Binary framing on existing WS
- **Effort**: ~1 wk server + 1 wk clients. 70 event types flow through 4-5 chokepoints (`sendToClient`, `broadcastToConversation`).
- **Perf**: MessagePack ~55% smaller on Chatyy shapes; Protobuf 60-65% with heavier schema burden.
- **Reliability**: zero inherent — still need existing `delivery_ack` events.
- **Risks**: Go/JS schema drift; debugging needs msgpack decoder; +18KB gz web bundle.
- **Compat**: 100% — same URL, negotiate via `Sec-WebSocket-Protocol: chatyy.msgpack.v1`; old clients keep JSON.

### B — MQTT 5 over WS
- **Effort**: broker + auth bridge to PHP `chat_auth`, redo every pub/sub, rewrite presence (LWT replaces PG rows). 134 Go services don't speak MQTT.
- **Perf**: marginal — MQTT header is 2-5B but payload encoding unchanged.
- **Reliability**: real — QoS 1 holds until ACK, LWT replaces ad-hoc disconnect logic.
- **Risks**: broker outage = everyone down; we currently survive `chatyy-ws-go` restart in ~3s. EMQX cluster ops on one box is fine but adds a critical dependency.
- **Compat**: LiveKit/nginx/CF all fine. PG presence becomes redundant.
- **Verdict**: real project, not refactor. Only justified if we need QoS 2 for billing/compliance.

### C — gRPC bidi streams
- **Effort**: rewrite around `grpc.ServerStream`; JS needs Connect-ES (grpc-web is unary/server-stream only). `@grpc/grpc-js` doesn't run on RN.
- **Perf**: HTTP/2 mux helps if many parallel streams; we have one socket/user.
- **Risks**: **Cloudflare free strips HTTP/2 trailers** → breaks bidi. Would need to bypass CF (already grey-cloud) but lose DDoS shield. PWA bundle +120KB.

### D — WebTransport
- **Effort**: `quic-go/webtransport-go` still moving; nginx has no WT reverse proxy; RN has zero polyfill (custom native module per platform).
- **Perf**: 0-RTT reconnect is real magic on mobile (tunnel resume).
- **Risks**: experimental, CF doesn't proxy WT to origin yet.
- **Verdict**: 2027.

---

## 2. Recommendation

**Option A (MessagePack on existing WS).** Everything else is a year-long migration for one dev team. Binary framing buys 55% bandwidth, zero infra churn, untouched Cloudflare/nginx/LiveKit, no TestFlight resubmission needed. Then earn the right to do more.

WebTransport stays on watchlist; revisit when `react-native-webtransport` is real and CF proxies it. MQTT only if QoS 2 becomes a hard requirement.

---

## 3. Phased migration

### Phase 1 — MessagePack envelope (2 wk calendar, 8 dev-days)

1. Add `github.com/vmihailenco/msgpack/v5` to `go.mod`.
2. Negotiate via WS subprotocol; default JSON if client doesn't ask.
3. Wrap the 4 send chokepoints in a single `encode(client, payload)` helper.
4. JS: add `@msgpack/msgpack` (18KB gz), set `ws.binaryType='arraybuffer'`, branch `onmessage` on `ArrayBuffer`.
5. Roll out: server first (backward compatible), then OTA flips clients. Old clients keep working forever.
6. Measure: bytes-in/out per connection on `duarte@chatyy.com.br` for 48h.

### Phase 2 — Op-code table + delta presence (1 wk, 4 dev-days)

1. Replace `{"type":"presence","email":"x@y","status":"online"}` (~55B) with `[OP_PRESENCE, userIdx, statusByte]` (~4B). Dominates contact-list traffic.
2. Generate op-code enum from a single `events.yaml` consumed by Go + JS at build.
3. Batch presence into 100ms windows server-side (partially done already).

### Phase 3 — Resumable sessions (1 wk, 5 dev-days)

1. Server: on disconnect, hold the `Client` + ring buffer of last-N outbound frames for 30s, keyed by `resume_token` returned at auth.
2. Client: on reconnect, send `resume_token` + last-ack-seq; server replays missed frames.
3. The only "WhatsApp-grade" reliability win that does NOT require swapping transport. Kills the "tunnel for 8s, lose 3 messages" class.

### Phase 4 (optional, 2027) — Re-evaluate

If still bandwidth-bound on BR mobile, Protobuf swap (1-day mechanical change once msgpack envelope exists). If reliability complaints persist on lossy networks, revisit WebTransport.

**Total Phases 1-3:** ~3 weeks of one dev. Outcome: ~55% bandwidth drop + ~zero "lost message after wifi flap" reports.

---

## 4. Phase 1 code skeleton

### 4.1 Go (`/opt/chatyy-ws-go/main.go`)

```go
import (
    "github.com/vmihailenco/msgpack/v5"
)

type Client struct {
    // ... existing fields
    Codec string // "json" or "msgpack"
}

// In the HTTP upgrade handler:
var upgrader = websocket.Upgrader{
    Subprotocols: []string{"chatyy.msgpack.v1", "chatyy.json.v1"},
    CheckOrigin:  func(r *http.Request) bool { return true },
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil { return }
    codec := "json"
    if conn.Subprotocol() == "chatyy.msgpack.v1" {
        codec = "msgpack"
    }
    client := &Client{conn: conn, Codec: codec /* ... */}
    // ... rest
}

// Single chokepoint replaces all WriteJSON sites:
func (c *Client) send(payload map[string]interface{}) error {
    if c.Codec == "msgpack" {
        b, err := msgpack.Marshal(payload)
        if err != nil { return err }
        return c.conn.WriteMessage(websocket.BinaryMessage, b)
    }
    return c.conn.WriteJSON(payload)
}

// Read side:
func (c *Client) readLoop() {
    for {
        mt, data, err := c.conn.ReadMessage()
        if err != nil { return }
        var msg map[string]interface{}
        if mt == websocket.BinaryMessage {
            if err := msgpack.Unmarshal(data, &msg); err != nil { continue }
        } else {
            if err := json.Unmarshal(data, &msg); err != nil { continue }
        }
        c.handleMessage(msg)
    }
}
```

### 4.2 JS client (`services/websocket.js`)

```js
import { encode, decode } from '@msgpack/msgpack';

const USE_MSGPACK = true; // remote-config-flippable

const proto = USE_MSGPACK ? 'chatyy.msgpack.v1' : 'chatyy.json.v1';
this.ws = new WebSocket(url, proto);
this.ws.binaryType = 'arraybuffer';

this.ws.onmessage = (event) => {
  let msg;
  if (event.data instanceof ArrayBuffer) {
    msg = decode(new Uint8Array(event.data));
  } else {
    msg = JSON.parse(event.data);
  }
  this._dispatch(msg);
};

send(data) {
  if (this.ws?.readyState !== 1) return false;
  if (this.ws.protocol === 'chatyy.msgpack.v1') {
    this.ws.send(encode(data));
  } else {
    this.ws.send(JSON.stringify(data));
  }
  return true;
}
```

### 4.3 Rollout safety

- Ship Go side first; subprotocol header defaults old clients to JSON. Zero risk to live users.
- OTA bumps `USE_MSGPACK=true` behind a remote-config flag; revert with one push if metrics regress.
- Add a `/ws/health` field reporting `msgpack_clients` count so we can watch adoption.

---

**TL;DR:** Skip MQTT/gRPC/WebTransport for now. MessagePack on the existing WS plus op-codes plus resume tokens gets us ~80% of the perceived WhatsApp-grade upgrade for ~3 dev-weeks and zero infra change.
