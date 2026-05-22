# WASP — WhatsApp-style STUN Protocol Clone

**Agent 4 / 10 — Single-port NAT traversal + media relay design**
**Author:** automation (design doc, no prod code touched)
**Target host:** 217.216.67.99 (Contabo NY, 18vCPU/94GB, alongside chatyy-ws-cpp)

---

## 1. Motivation

coturn (current TURN/STUN) listens on N ports (3478 UDP, 3478 TCP, 5349 TLS, 49152-65535 relay range). Each call grabs an ephemeral port, holding kernel state. Drawbacks observed:

- Mid-call relay failover impossible: client allocation is bound to one IP+port, coturn dies → call dies.
- Firewall ops nightmare: enterprise networks block the high-port range.
- Memory cost: ~6KB kernel + ~2KB userland per allocation; 10k calls ≈ 80MB just for sockets.
- State machine: server holds `allocation → permissions → channel_binding` tree per client, so horizontal scale = sticky LB.

WASP collapses everything onto **one UDP port (8443 chosen — already TLS-friendly on enterprise firewalls and not collision-prone with our nginx 443)** and pushes state to the client.

---

## 2. Frame Multiplex Spec (byte-level)

Every UDP datagram begins with a 4-byte magic + 1-byte type discriminator. We keep STUN's RFC5389 magic-cookie (`0x2112A442`) in the body for legacy paths, but the outer framing is ours.

```
Offset  Size  Field
0       2     wasp_magic    = 0xWA5P (0x57415350 truncated to 16-bit: 0x5750)
2       1     frame_type    (see below)
3       1     flags         (bit0=encrypted, bit1=ack_req, bit2=fragment, bit3-7 reserved)
4       4     call_id_hi    (high 32 bits of 64-bit callId)
8       4     call_id_lo
12      2     seq           (per-(callId,direction) monotonic)
14      2     payload_len
16      N     payload
```

`frame_type` values:

| Hex  | Name              | Notes                                              |
|------|-------------------|----------------------------------------------------|
| 0x01 | `STUN_LEGACY`     | Wraps a raw STUN message (compat with libwebrtc).  |
| 0x02 | `RELAY_ALLOC`     | Allocate logical relay slot (no kernel port alloc).|
| 0x03 | `RELAY_DATA`      | Opaque media bytes (SRTP, already encrypted).      |
| 0x04 | `RELAY_CONTROL`   | Heartbeat, bandwidth report, peer-addr update.     |
| 0x05 | `FAILOVER_HINT`   | Server→client: "I'm draining, here are 3 PoPs".    |
| 0x06 | `PROBE`           | Latency RTT measurement (client→server→client).    |
| 0xFE | `LEGACY_TURN`     | Passthrough to coturn during migration.            |
| 0xFF | `RESERVED`        |                                                    |

Detection: if the first two bytes are `0x00 0x01` (STUN BINDING_REQUEST), we treat the packet as legacy and route to a small embedded STUN handler — no need to upgrade `libwebrtc` clients on day one. Bit 14 of byte 0 distinguishes STUN (always 0) from WASP frames (we picked `0x57` which has bit 14 = 0 too, so we additionally check bytes 2–3 — STUN's length follows, WASP's frame_type+flags will not match the STUN magic cookie at offset 4–7).

Concretely the dispatch is:

```
if (pkt[4..8] == 0x2112A442) → STUN path
else if (pkt[0..2] == 0x5750)  → WASP path
else                            → drop + metric
```

---

## 3. State Distribution

### Client holds (persistent, ~80 bytes per call):
- `call_id` (64-bit, generated client-side, embeds 16-bit shard hint)
- `relay_endpoint` (ip+port of current PoP)
- `peer_relay_endpoint` (for symmetric mode)
- `srtp_keys` (already client-managed in WebRTC)
- `last_seq_tx`, `last_seq_rx`
- `pop_candidates[3]` (failover list, learned from `FAILOVER_HINT`)

### Server holds (ephemeral, ~32 bytes per active call, evictable):
- `call_id → {peer_a_addr, peer_b_addr, last_seen_ts, bw_estimate}`
- LRU eviction at 60s idle. **Bandwidth estimate is explicitly ephemeral** — losing it just costs one re-estimation cycle (~2s), per Meta's atScale guidance.

State is sharded by `hash(call_id) mod N_workers` inside a single process. No cross-shard locks. Inter-PoP state is **not replicated** — failover is client-driven.

---

## 4. State Diagrams

### Client

```
            ┌──────────┐
            │   IDLE   │
            └────┬─────┘
                 │ user_starts_call
                 ▼
            ┌──────────┐  RELAY_ALLOC ──► server
            │ ALLOCATING├──── timeout(500ms) ──┐
            └────┬─────┘                       │
                 │ alloc_ok                    ▼
                 ▼                       try_next_pop
            ┌──────────┐
            │ CONNECTED│◄──┐ RELAY_DATA in/out
            └────┬─────┘   │
                 │         │ heartbeat 5s
                 │ peer_change_addr
                 ▼
            ┌──────────┐
            │ MIGRATING│ (re-bind without renegotiate)
            └────┬─────┘
                 │ FAILOVER_HINT received OR 3× heartbeat miss
                 ▼
            ┌──────────┐
            │ FAILING  │── try pop_candidates[i++] ──► ALLOCATING (same call_id)
            └──────────┘
```

### Server (per worker shard)

```
recv() ──► classify_frame ──► switch:
   STUN_LEGACY  → reflect XOR-MAPPED-ADDRESS → send()
   RELAY_ALLOC  → upsert(call_id, peer_addr) → ACK
   RELAY_DATA   → lookup(call_id) → forward to peer_addr
   RELAY_CTRL   → update bw / peer / heartbeat
   PROBE        → echo with server_ts
   (unknown)    → drop, counter++
```

Worker is a pure function over `(packet, shard_map)`; no per-call FSM in kernel.

---

## 5. Failover Sequence (ASCII)

```
Client A          PoP-NYC (dying)        PoP-MIA (healthy)        Client B
   │                  │                       │                       │
   │── RELAY_DATA ───►│── forward ────────────┼──────────────────────►│
   │                  │                       │                       │
   │◄── FAILOVER_HINT─│ (drain signal, lists MIA+ATL+ORD)             │
   │                  X (process exits)       │                       │
   │── RELAY_DATA ───►X (no response)         │                       │
   │── 3× timeout, switch to pop_candidates[0]=MIA                    │
   │                                          │                       │
   │── RELAY_ALLOC(call_id=same) ────────────►│                       │
   │◄── ALLOC_OK ─────────────────────────────│                       │
   │── RELAY_DATA ───────────────────────────►│── forward ───────────►│
   │                                          │◄── RELAY_ALLOC ───────│ (B also switches)
   │                                          │                       │
       total gap: ~150-300ms (3× 50ms heartbeat + 1 RTT to MIA)
```

Server PoP-MIA learns the call_id *from the first packet*; no pre-existing state needed. SRTP keys never leave the clients — failover is invisible at the media layer.

---

## 6. Performance Targets & Expected Benchmarks

Single box (18 vCPU / 94 GB / NVMe):

| Metric                          | coturn today | WASP target | Rationale                       |
|---------------------------------|--------------|-------------|---------------------------------|
| Concurrent calls                | ~2,500       | 10,000      | No per-call kernel socket       |
| p50 relay latency added         | 4 ms         | 1.5 ms      | Single hop, no allocation lookup chain |
| p99 relay latency added         | 35 ms        | <50 ms      | GC-free C++, io_uring batched recv |
| Memory per call                 | ~8 KB        | ~96 B       | Client holds the heavy state    |
| Failover MTTR                   | call drops   | 150-300 ms  | Client-driven                   |
| CPU @ 10k calls (50kbps each)   | n/a          | ~55% of 18c | recvmmsg + sendmmsg, 256-msg batches |

Stress plan: replay 1 h of recorded SRTP from `livekit.chatyy.com.br` calls × 100 concurrent users.

---

## 7. Multi-PoP Routing

PoP picking is **client-side DNS + RTT probe**:

1. Client resolves `wasp.chatyy.com.br` → CNAME → Cloudflare GeoSteering → returns 3 closest PoPs.
2. Client sends `PROBE` to all three in parallel.
3. Picks lowest p50 RTT over 3 probes (~150 ms total).
4. Stores top 3 as `pop_candidates` for failover.

Stateless server: any PoP can accept any `call_id`. Peers may even ride different PoPs (asymmetric routing) — `RELAY_CTRL` carries the peer's chosen PoP so each side knows where to forward (a 2-hop relay path when peers disagree; rare, costs ~10ms inter-PoP within continent).

Initial PoPs: NYC (217.216.67.99), and reuse api-eu/api-asia/api-br hosts already in infra (see `infrastructure_2026_04.md`). DNS via Cloudflare load balancer (geo + health-check).

---

## 8. Compatibility During Migration

- **libwebrtc / PJSIP clients**: continue to send STUN BINDING + TURN ALLOCATE on the same port 8443. The WASP listener detects RFC5389 magic and dispatches into an embedded mini-STUN handler. For TURN we set `0xFE LEGACY_TURN` frames and proxy locally to coturn on 127.0.0.1:3478. This way old app builds keep working while new builds opt-in via a feature flag.
- **Feature flag**: `wasp_enabled` in `chat_user_settings`, defaults off; flip per cohort.
- **Browser/web**: keep TURN for at least 6 months (no `RTCWaspTransport` API exists; would need a SFU adapter).

---

## 9. Reference C++ Skeleton

Reuse the uWebSockets + libpqxx + libhiredis pattern from `/opt/chatyy-ws-cpp/src`. UDP path uses raw `socket(AF_INET, SOCK_DGRAM)` + `recvmmsg`, not uWS (which is TCP-centric).

```cpp
// /opt/chatyy-wasp-cpp/src/wasp.hpp

namespace wasp {

constexpr uint16_t kMagic = 0x5750;
constexpr size_t   kHeaderLen = 16;
constexpr size_t   kMaxFrame  = 1500;

enum class FrameType : uint8_t {
    StunLegacy   = 0x01,
    RelayAlloc   = 0x02,
    RelayData    = 0x03,
    RelayControl = 0x04,
    FailoverHint = 0x05,
    Probe        = 0x06,
    LegacyTurn   = 0xFE,
};

struct Frame {
    FrameType type;
    uint8_t   flags;
    uint64_t  call_id;
    uint16_t  seq;
    std::string_view payload;       // zero-copy over recv buffer
    static std::optional<Frame> parse(std::span<const uint8_t> pkt);
    size_t serialize(std::span<uint8_t> out) const;
};

struct CallEntry {
    sockaddr_in peer_a{}, peer_b{};
    uint64_t    last_seen_us{};
    uint32_t    bw_estimate_bps{};
};

class Shard {
public:
    void on_packet(const sockaddr_in& src, std::span<const uint8_t> pkt);
    void tick(uint64_t now_us);    // evict idle, emit drain hints
private:
    folly::F14FastMap<uint64_t, CallEntry> calls_;   // ~32B/entry
    void handle_alloc  (const sockaddr_in&, const Frame&);
    void handle_data   (const sockaddr_in&, const Frame&);
    void handle_control(const sockaddr_in&, const Frame&);
    void handle_stun   (const sockaddr_in&, std::span<const uint8_t>);
};

class Server {
public:
    explicit Server(uint16_t port, unsigned n_workers);
    void run();                    // blocks; one thread per shard, SO_REUSEPORT
    void request_drain();          // SIGTERM handler → emits FailoverHint to all
private:
    int sock_{-1};
    std::vector<std::jthread> workers_;
    std::vector<Shard> shards_;
};

// Hot path uses recvmmsg/sendmmsg in batches of 256 for syscall amortization.
void Server::worker_loop(unsigned id) {
    std::array<mmsghdr,  256> msgs{};
    std::array<iovec,    256> iovs{};
    std::array<std::array<uint8_t, kMaxFrame>, 256> bufs{};
    std::array<sockaddr_in, 256> addrs{};
    // setup omitted...
    while (!stop_) {
        int n = ::recvmmsg(sock_, msgs.data(), msgs.size(), MSG_WAITFORONE, nullptr);
        for (int i = 0; i < n; ++i) {
            shards_[id].on_packet(addrs[i],
                {bufs[i].data(), msgs[i].msg_len});
        }
    }
}

} // namespace wasp
```

Build alongside chatyy-ws-cpp, deploy via systemd unit `chatyy-wasp-cpp.service`, listen on `0.0.0.0:8443/udp` (TLS 443/tcp stays nginx).

---

## 10. Migration Path from coturn

| Phase | Duration | Action                                                                     | Rollback                  |
|-------|----------|----------------------------------------------------------------------------|---------------------------|
| 0     | 1 wk     | Deploy WASP on 217.216.67.99:8443, accepts only `PROBE`. Metrics only.     | `systemctl stop`          |
| 1     | 1 wk     | Enable `STUN_LEGACY` and `LEGACY_TURN` passthrough. Co-exist with coturn.  | nginx routes back to 3478 |
| 2     | 2 wk     | New iOS/Android builds opt-in (1% cohort) to native WASP.                  | feature flag off          |
| 3     | 4 wk     | Ramp 1% → 10% → 50% → 100%. Monitor `wasp_call_quality` dash.              | flag off                  |
| 4     | 4 wk     | Multi-PoP rollout (EU, Asia, BR). Web stays on coturn.                     | DNS revert                |
| 5     | open     | coturn kept as fallback for browsers & legacy builds (<v2.6.0).            | n/a                       |

No `cutover.sh apply` switch — the protocols coexist on port 8443 for the entire migration. Listening sockets are independent (coturn on 3478, WASP on 8443).

---

## 11. Risk Assessment

| Risk                                                   | Sev | Mitigation                                                       |
|--------------------------------------------------------|-----|------------------------------------------------------------------|
| Custom protocol → no Wireshark dissector → debugging hell | H | Ship dissector Lua plugin alongside; `wasp-dump` CLI tool        |
| Client-held state lost on app kill → orphan calls      | M   | LRU 60s server eviction; clients restore on next foreground      |
| Single UDP port blocked by enterprise FW (some block 8443/udp) | M | Fall back to TURN/TCP via coturn; advertise via `FAILOVER_HINT`  |
| call_id collision (64-bit random)                      | L   | Birthday at 2^32 calls (~4B); add 16-bit PoP-shard prefix        |
| Asymmetric PoP path adds 2nd hop                       | L   | Acceptable (<10ms intra-continent); both clients converge soon   |
| Amplification attack (small request → big reply)       | H   | All replies ≤ request size; rate limit `RELAY_ALLOC` per src IP  |
| No DTLS-SRTP handshake observability                   | M   | Server only sees encrypted bytes — explicit, by design; metrics from clients via `RELAY_CONTROL` |
| Inter-PoP routing depends on Cloudflare LB             | M   | Static `pop_candidates` fallback baked in client config          |
| C++ rewrite bugs (use-after-free in shard map)         | H   | ASAN+UBSAN in CI; F14FastMap is well-vetted; shard-thread-local removes cross-thread aliasing |
| Cellular NAT rebinds public port mid-call              | L   | `RELAY_CONTROL` peer-addr update handles this in <1 RTT          |

---

## 12. Open Questions for Agents 5–10

- Auth: `RELAY_ALLOC` HMAC w/ short-lived JWT? (Agent 6)
- Abuse/billing: count bytes w/o per-call state — sampling vs client-attested+audit.
- Web beyond TURN: WebTransport-over-QUIC gateway.
- Recording: WASP is E2E-encrypted → client-side opt-in only.

**End of design doc. No production code modified.**
