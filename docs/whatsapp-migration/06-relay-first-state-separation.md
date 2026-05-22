# 06 — Relay-First Connection + Critical/Ephemeral State Separation

**Agent 6 of 10** — design only, no production code changes.

WhatsApp achieves <500ms call setup because media flows through a **conf
bridge (relay)** the instant the callee answers; ICE/P2P upgrade happens
asynchronously and, if it succeeds, the path is swapped mid-stream with
**RTP sequence continuity** (the webrtchacks reverse-engineering noted the
sequence number incremented by exactly one across the swap). Our current
LiveKit setup does the opposite: it tries P2P first, falling back to TURN
only after ICE fails — adding 1–4 s to setup time on cellular/CGNAT.

This doc designs the inversion plus the state model that makes a relay
swap (or relay failover) safe in <2 s.

---

## 1. Sequence Diagram — Phases 0 → 3

```
Caller (A)                 Signaling          Relay-Primary       Callee (B)
   |  call_invite (call_id, key)  |               |                 |
   |----------------------------->|               |                 |
   |  relay_token (TURN cred +    |               |                 |
   |  SFU room, < 50 ms)          |               |                 |
   |<-----------------------------|               |                 |
   |  TURN allocate + DTLS to SFU |               |                 |
   |-----------------------------------------------> [PHASE 0]      |
   |                              | push (VoIP)   |                 |
   |                              |---------------------------------|
   |                              |     answer    |                 |
   |                              |<----------------------------    |
   |                              |  relay_token (same room)  ----> |
   |                              |                                 |
   |                              |     TURN allocate + DTLS  <---  |
   |                              |                                 |
   | <===== media flowing via relay (both legs) =====> [PHASE 1]    |
   |       audible to user in < 500 ms after answer                 |
   |                                                                |
   |  ICE candidates  ---signaling--->            <---signaling---  |
   |  STUN binding requests (background)                            |
   |                                              [PHASE 2]         |
   |                                                                |
   |  if ICE-CHECK SUCCEEDED for a candidate pair:                  |
   |     SFU emits `path_upgrade_ready` with handover seqno         |
   |     client swaps sendto() addr; keeps RTP seqno + SRTP roc     |
   |                                              [PHASE 3]         |
   |  <=========== media now P2P, relay torn down ===============>  |
   |                                                                |
   |  if ICE never succeeds in 8 s -> stay on relay (PHASE 1 sticky)|
```

Phase 0 is the **must-be-fast** path. Token + TURN allocate + DTLS are
the only blockers between `answer` and audible audio. We pre-warm the
TURN allocate on the caller side **at call_invite time**, not at answer
time — that's the single biggest win.

---

## 2. Critical vs Ephemeral State

| Bucket | Item | Owner | Survives crash? | Why |
|---|---|---|---|---|
| **CRITICAL** | `call_id` | PG `chat_call_active` | Yes | Reconnect key |
| | members[] (email, device_id) | PG | Yes | ACL on rejoin |
| | call_type (1:1 / group) | PG | Yes | Routing logic |
| | encryption keys (per-sender, ratchet head) | client + KMS-wrapped in PG | Yes | E2EE continuity across relay swap |
| | TURN realm / cred ttl | PG (issued_at, exp) | Yes | Avoid re-mint storm |
| | started_at, locked flag | PG `chat_call_state` (existing) | Yes | Idempotent join |
| **EPHEMERAL** | bandwidth estimate per stream | LK SFU RAM | No | Re-measured in 200 ms |
| | dominant speaker | LK SFU RAM | No | Recomputed continuously |
| | audio level meters (RMS) | LK SFU RAM | No | UI only |
| | jitter buffer fill | client | No | Local |
| | NACK / PLI counters | LK SFU RAM | No | Stats only |
| | active simulcast layer per sub | LK SFU RAM | No | Re-negotiated on reconnect |
| | ICE pair RTT samples | client | No | Probing artefact |

**Rule of thumb**: anything a fresh relay needs to admit the same call
into the same E2EE session = CRITICAL. Anything that's recomputed from
RTP within one RTT = EPHEMERAL. The LK SFU process must hold **only
EPHEMERAL** so we can kill -9 it without losing calls.

---

## 3. DB Schema Additions

Existing tables: `chat_call_history`, `chat_call_state`, `chat_call_participants`.
New required:

```sql
CREATE TABLE chat_call_active (
  call_id        TEXT PRIMARY KEY,
  call_type      TEXT NOT NULL,                -- '1to1' | 'group'
  initiator      CITEXT NOT NULL,
  relay_pool     TEXT NOT NULL,                -- 'us-central-a' | 'eu-fr-b'
  relay_node     TEXT NOT NULL,                -- specific LK node hostname
  backup_relay   TEXT NOT NULL,                -- pre-assigned failover node
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,         -- now()+4h hard cap
  state          TEXT NOT NULL DEFAULT 'ringing', -- ringing|active|ended
  e2ee_room_key  BYTEA,                        -- wrapped with per-room KEK
  CONSTRAINT chk_state CHECK (state IN ('ringing','active','ended'))
);
CREATE INDEX chat_call_active_state_idx ON chat_call_active(state)
  WHERE state <> 'ended';

CREATE TABLE chat_call_devices (
  call_id    TEXT REFERENCES chat_call_active(call_id) ON DELETE CASCADE,
  email      CITEXT NOT NULL,
  device_id  TEXT NOT NULL,
  joined_at  TIMESTAMPTZ DEFAULT now(),
  last_seen  TIMESTAMPTZ DEFAULT now(),        -- updated by SFU heartbeat
  ice_state  TEXT DEFAULT 'relay',             -- 'relay'|'p2p'|'failover'
  PRIMARY KEY (call_id, email, device_id)
);
```

`chat_call_active` replaces ad-hoc memory in the WS server. `last_seen`
is the only column the LK SFU writes (every 5 s heartbeat); everything
else is set by `chat.php` at invite/answer time.

---

## 4. Failover Sequence (relay dies)

```
t=0     SFU-A panics (OOM / kernel kill)
t=0.0   client A loses DTLS (ICE failed event in 200-500 ms typical)
t=0.3   client reads chat_call_active.backup_relay from API (cached at join)
t=0.5   TURN allocate on SFU-B (pre-warmed cred, same TTL)
t=0.9   DTLS handshake to SFU-B (resumed via PSK if available, else full)
t=1.4   re-publish tracks; SRTP key kept (E2EE end-to-end, SFU never had it)
t=1.6   B-side does same, both sides on SFU-B
t<2.0   audible audio resumed
```

Key invariant: the SFU never holds the E2EE key. SRTP between client and
SFU is hop-only; the inner E2EE layer (Insertable Streams / SFrame) means
the swap doesn't require any rekey. **Without E2EE we'd need a fresh
DTLS-SRTP key derivation per swap, blowing the <2 s budget.**

---

## 5. Current vs Target Behavior

| Aspect | Today (LiveKit default) | Target (relay-first) |
|---|---|---|
| First media packet | After ICE checks complete (1–4 s on cellular) | Within 500 ms of `answer` via TURN |
| TURN allocate timing | After P2P fails | At `call_invite` (caller) and `relay_token` (callee) — parallel |
| Path priority | host > srflx > relay | relay-immediate, P2P upgrade async |
| Failover | Manual reconnect, lose ~5–10 s | Auto via `backup_relay` in <2 s |
| Critical state on crash | Lost (LK in-memory rooms) | Survives (PG `chat_call_active`) |
| RTP continuity on swap | New SSRC, gap in playback | Same SSRC, +1 seqno (SFrame frame index preserved) |

---

## 6. LiveKit Config Changes

LK exposes the relay-vs-P2P tradeoff in `turnconfig.go` (server-side) and
`RTCConfiguration.iceTransportPolicy` (client). We need both:

**Server (`livekit.yaml`)**:
```yaml
turn:
  enabled: true
  domain: turn.chatyy.com.br
  tls_port: 5349
  udp_port: 3478
  relay_range_start: 50000
  relay_range_end: 60000
rtc:
  # force initial offer to include only relay candidates
  use_external_ip: false
  candidates_to_advertise: ["relay"]   # custom flag, see patch
  # P2P upgrade path stays open via trickle
  ice_lite: false                      # we want full ICE for upgrade
  enable_ice_restart: true
```

**Client (`useRoom` in our app)**:
```js
new Room({
  rtcConfig: {
    iceTransportPolicy: 'relay',       // phase 0 only
  },
  // after 'connected' event:
  // room.engine.client.pc.setConfiguration({iceTransportPolicy:'all'})
  // → triggers ICE restart, P2P pair gets tested
});
```

The two-stage `iceTransportPolicy` flip is the key trick. Stage 1 forces
relay; stage 2 (fired 1 s after `Connected`) opens the P2P path so the
SFU can hand off if a host pair succeeds. LK's `selected_candidate_pair_changed`
event signals when the swap actually happened — we log this to measure
P2P upgrade rate (target: >60% on Wi-Fi, >20% on cellular).

---

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| TURN bandwidth cost spikes (every call relayed) | High | Auto-downgrade to P2P at phase 3 keeps median session <30 s on relay. Budget for 100% relay worst-case anyway (group calls already are). |
| SFU process holds critical state by accident | High | Code review gate: any new field added to `Room` struct must be classified C/E in PR description. Add lint rule. |
| Backup relay also dies (correlated failure, same DC) | Medium | `backup_relay` must be in a different pool (us-central-a → us-east-b). Validate at insert time. |
| ICE upgrade fights with relay during phase 2 (packet duplication) | Medium | SFU emits `path_upgrade_ready` with explicit handover seqno; client drops dup by seqno window. |
| `chat_call_active` row leak on client crash | Low | TTL: `expires_at = now()+4h` + cron purges `state='active' AND last_seen < now()-2min`. |
| SFrame not yet enabled → swap requires rekey | High (blocking) | Agent 4 (E2EE) must ship SFrame before relay-first can guarantee <2 s failover. Sequence the rollouts. |
| Telnyx TURN realm vs LK TURN realm mismatch | Medium | Standardize on LK's TURN only for media; Telnyx is SIP-only post-2026-05-09. |

---

## 8. Rollout Order

1. Ship `chat_call_active` + `chat_call_devices` tables (migration only, dual-write from chat.php).
2. Enable two-stage `iceTransportPolicy` on a 5% canary.
3. Measure phase-0 audible-time histogram (target p50 <500 ms, p95 <900 ms).
4. Wire `backup_relay` selection at invite time.
5. Implement SFU heartbeat → `chat_call_devices.last_seen`.
6. Enable client-side relay-failover fetch on DTLS loss.
7. Coordinate with Agent 4 (SFrame) before declaring P2P-upgrade safe for E2EE rooms.

End of document.
