# 05 — Multi-PoP Infrastructure for Chatyy Calls

**Agent 5 of 10 · WhatsApp Migration Track**
**Status:** Design proposal. No production code touched.

WhatsApp piggybacks Meta's ~1000 PoPs and a private backbone. We won't match that, but a 3-PoP starter (BR / EU / US) cuts p50 RTT for non-NYC users from ~140 ms to <30 ms — the bulk of the WhatsApp-feel win — for under $60/mo.

---

## 1. Provider Comparison

| Provider | Cheapest call-grade box | Regions we care about | UDP custom ports | Egress | Notes |
|---|---|---|---|---|---|
| **Contabo** (current) | VPS S ~$7/mo, 4 vCPU/8 GB | EU, US Central/East, Singapore. **No BR.** | Yes | 32 TB | Cheapest RAM; oversubscribed CPU. Already host. |
| **Hetzner Cloud** | CPX21 ~€6/mo, 3 vCPU/4 GB | Falkenstein, Nuremberg, Helsinki, Ashburn, Hillsboro, Singapore. **No BR.** | Yes | 20 TB | Best price/perf in EU. €1/TB overage. |
| **Vultr** | High-Freq 1 vCPU/2 GB $12/mo; "Cloud Compute" 1 vCPU/2 GB $6/mo | **São Paulo**, Frankfurt, Amsterdam, NJ, Atlanta, Tokyo, Sydney, Mumbai (28 total) | Yes | 2–3 TB then $0.01/GB | **Only budget provider with São Paulo.** |
| **DigitalOcean** | s-2vcpu-2gb $18/mo | Frankfurt, Amsterdam, NYC, SF, Bangalore, Sydney. **No BR.** | Yes | 3 TB | More expensive than Vultr, similar features. |
| **OVH / Scaleway** | VPS Starter ~€4/mo | EU heavy, Warsaw, Beauharnois CA. **No BR direct.** | Yes | Unmetered (capped throughput) | Cheap EU, weak LATAM. |
| **AWS Lightsail SP** | 2 vCPU/4 GB $20/mo, **São Paulo** | Global | Yes | 4 TB | 2× Vultr cost; only if we already use AWS. |
| **Magalu Cloud / Locaweb** | R$50–80/mo SP | Brazil only | Yes | Low | Domestic BR if Vultr SP latency disappoints (rare). |

**Recommended starter trio (Vultr-heavy for SP availability):**

| PoP | Provider | Plan | Cost | Public IP role |
|---|---|---|---|---|
| `pop-sao` (São Paulo) | Vultr Cloud Compute | 2 vCPU / 4 GB / 80 GB | **$24/mo** | turn-sao, sfu-sao, ws-sao |
| `pop-fra` (Frankfurt) | Hetzner CPX21 | 3 vCPU / 4 GB / 80 GB | **€6 ≈ $7/mo** | turn-fra, sfu-fra, ws-fra |
| `pop-iad` (Virginia/Ashburn) | Hetzner CPX21 | 3 vCPU / 4 GB / 80 GB | **€6 ≈ $7/mo** | turn-iad, sfu-iad, ws-iad |
| **Total compute** | | | **~$38/mo** | |
| Origin (existing) | Contabo NY 217.216.67.99 | 18 vCPU / 94 GB | $40/mo (sunk) | PG master, mail, API |

Add ~$5/mo egress headroom → **<$50/mo for 3 PoPs**. Room to add Tokyo (Vultr $6) and Sydney (Vultr $6) later for APAC = <$65/mo.

---

## 2. PoP Role

Each PoP runs the same stack via one `docker-compose.pop.yml`:

```
+-- coturn (UDP 3478, TLS 5349, relay 49160-49300/UDP)
+-- livekit-sfu (UDP 7881-7882, TCP 7880 API)  [future: WASP relay]
+-- nginx (443 TLS termination, /ws -> chatyy-ws-cpp local)
+-- chatyy-ws-cpp (8085, same binary as origin)
+-- pg-replica (read-only streaming replica of origin chatyy_main)
+-- node-exporter + blackbox-exporter (metrics + probes)
```

PoP is **stateless for writes**. Auth lookups hit local `pg-replica` (sub-ms). Writes (call_started, message_sent) go to origin master over WireGuard tunnel.

---

## 3. 3-PoP Starter Architecture

```
                           Cloudflare (HTTP+WS proxy, geo-steered)
                           api.chatyy.com.br  /  ws.chatyy.com.br
                                       |
              +------------------------+-------------------------+
              |                        |                         |
        pop-sao (Vultr SP)       pop-fra (Hetzner FRA)     pop-iad (Hetzner IAD)
        +------------+            +-------------+            +-------------+
        | nginx 443  |            | nginx 443   |            | nginx 443   |
        | ws-cpp     |            | ws-cpp      |            | ws-cpp      |
        | LK SFU     |            | LK SFU      |            | LK SFU      |
        | coturn     |            | coturn      |            | coturn      |
        | pg-replica |            | pg-replica  |            | pg-replica  |
        +-----+------+            +------+------+            +------+------+
              |                          |                          |
              +-----------+--------------+-------------+------------+
                          |  WireGuard mesh (10.88.0.0/24)          |
                          |  PG streaming repl + control plane RPC  |
                          v                                         v
                  +---------------------------------------+
                  |  Origin: Contabo NY 217.216.67.99     |
                  |  PG master, mail, web, control-plane  |
                  +---------------------------------------+

UDP media plane (NOT through Cloudflare):
  client --(STUN/TURN/SFU)--> nearest PoP <===> peer PoP <===> other client
```

---

## 4. Geo-Routing

Three layers, cheapest first:

1. **Cloudflare Geo Steering (HTTP+WS only).** Free tier doesn't support DNS load balancing with geo, but Argo / Load Balancer add-on does (~$5/mo per pool). Instead use **Cloudflare Workers** at `edge.chatyy.com.br/pop` returning the nearest PoP based on `request.cf.country` + `colo`. Free up to 100k req/day.
2. **DNS A-record with low TTL** for media plane (no CF proxy): `media.chatyy.com.br` → multiple A records, returned via geo. Use NS1 free (50k queries/mo) or **Bunny DNS GeoDNS** ($1/mo). Records: `BR/AR/CL/PY -> pop-sao`, `EU/AF -> pop-fra`, `default -> pop-iad`.
3. **Client-side latency probe (override).** On app launch the client does a 200-byte UDP echo to all PoPs in parallel, picks the lowest p50 over 5 samples. Cached for 30 min in MMKV, re-probed on network change. Beats DNS-only when a user is on a VPN or mobile carrier with odd routing. Probe endpoint: `coturn` STUN binding request (already there, costs us nothing).

Algorithm in pseudo-JS:

```js
async function pickPoP() {
  const cached = mmkv.get('pop.pick');
  if (cached && Date.now() - cached.t < 30*60_000) return cached.id;
  const pops = await fetch('https://edge.chatyy.com.br/pop').then(r=>r.json());
  const rtts = await Promise.all(pops.map(probeStun));    // 5 samples each, parallel
  const best = rtts.sort((a,b)=>a.p50-b.p50)[0];
  mmkv.set('pop.pick', {id: best.id, t: Date.now()});
  return best.id;
}
```

---

## 5. State Replication

| Data | Mechanism | RPO | Notes |
|---|---|---|---|
| Auth tokens (`chat_users`, `tokens` table) | PG streaming replica (`wal_level=replica`, `hot_standby=on`) over WireGuard | <1 s | Read-only at PoP, writes forwarded to origin |
| Device push addresses, call participant rows | Same | <1 s | |
| Call membership liveness (who's currently in room X) | LiveKit's own Redis or in-process registry; mirrored to PoP via Redis Sentinel or LK's room sync API | <500 ms | Acceptable to lose on PoP crash; client retries with backoff |
| Bandwidth estimates, congestion control, jitter buffers | In-memory only, per PoP | N/A | Lost on restart by design |
| Recording/transcript artifacts | Written to origin R2 bucket directly via signed PUT | best-effort | PoP buffers locally, ships within 5 min |

WireGuard tunnel: each PoP gets `10.88.0.N`, origin is `.1`. PG `pg_hba.conf` only allows replication from `10.88.0.0/24`.

---

## 6. PoP-to-PoP Relay (Cross-PoP Calls)

User Alice in São Paulo calls Bob in Berlin. Three options examined:

- **A. Both connect to ONE PoP (midpoint).** Simple, no relay needed. Pick the PoP whose sum-of-RTTs is minimum. For SP↔BER, midpoint is pop-iad (~110+90 ms = 200 ms RTT sum). Bad — worse than direct SP↔FRA via public internet.
- **B. Each connects to nearest PoP; PoPs relay media to each other over public internet.** SP↔FRA public-internet RTT ~190 ms; the second leg adds <5 ms per PoP for SFU forwarding. So Alice gets 30 ms to pop-sao + 190 ms pop-sao↔pop-fra + 20 ms pop-fra to Bob ≈ 240 ms one-way. Direct P2P SP↔BER is ~205 ms. **5 % worse than P2P but enables recording, multi-party, E2EE relay, mute-server semantics.**
- **C. Full mesh, dynamic per-call.** Use libp2p-style routing to pick best 1-hop or 2-hop path. Overkill for 3 PoPs.

**Recommended: B with P2P fallback.** When `pop_a == pop_b` (same-PoP call, ~70 % of calls based on user distribution), no relay. When different, SFU at each PoP forms a chain via persistent WireGuard tunnels (no re-handshake per call). When ICE negotiates and both peers can do direct UDP (no symmetric NAT), let them — relay only when needed.

Implementation: LiveKit supports **node-to-node forwarding** in distributed mode (since v1.6). Configure `region` per node, `node_ip` over WG IP, set `multi_node: true`. Each PoP's SFU is a node in one logical LK cluster.

---

## 7. Cost Projection

Assumes 30 % of MAU active monthly, 5 % concurrent at peak, avg call duration 4 min, audio bitrate 32 kbps Opus, video 400 kbps when on.

| Phase | MAU | Peak concurrent calls | Egress/mo (TB) | Compute | Egress | **Total** |
|---|---|---|---|---|---|---|
| Now (1k MAU, 1 PoP) | 1 000 | 50 | ~0.5 | $40 (sunk) | $0 | **$40** |
| 3 PoPs launch | 5 000 | 250 | ~2.5 | $38 | $0 (within caps) | **$78** |
| 10k MAU | 10 000 | 500 | ~5 | $38 | $0–10 (slight Vultr SP overage) | **$78–88** |
| 50k MAU | 50 000 | 2 500 | ~25 | bump pop-sao to 4 vCPU $32, pop-iad to CPX31 $14, pop-fra to CPX31 $14 = $60 | $40 (Vultr egress) | **$140** |
| 100k MAU | 100 000 | 5 000 | ~50 | dual node per PoP $120 + add pop-tyo + pop-syd $24 | $120 | **$304** |

For comparison, doing the same on AWS Chime/Agora would be **$5–15k/mo** at 100k MAU. We sit at 2 % of that.

---

## 8. Cloudflare Strategy

- **Use CF for:** `api.chatyy.com.br` (HTTP), `ws.chatyy.com.br` (WebSocket), static `chatyy.com.br`. CF terminates TLS, gives DDoS protection, hides PoP IPs.
- **Bypass CF for:** UDP media (`media.chatyy.com.br` A-records grey-cloud). CF Spectrum supports UDP but only on Enterprise (~$5k/mo). Not for us.
- **Workers** for geo-routing endpoint (free tier sufficient).
- **R2** for recording/HLS artifacts (already in use).

---

## 9. Monitoring

Each PoP runs `blackbox-exporter` scraping every 10 s:
- ICMP ping to every other PoP and to origin (latency, loss)
- STUN binding request to own coturn (self-check)
- WS upgrade probe to `wss://ws-<pop>/health`
- PG replica lag (`SELECT now() - pg_last_xact_replay_timestamp()`)

Prometheus scrape from origin (single tenant, free). Grafana dashboard with one panel per PoP. Alertmanager → existing Telegram bot when:
- `probe_success == 0` for >2 min (PoP down)
- PG replica lag >10 s
- Cross-PoP RTT >2× 7-day median

Heartbeat: each PoP POSTs `/internal/heartbeat` to origin every 15 s with own load metrics; origin uses this to update DNS geo-records dynamically (drain a PoP by stopping heartbeats → DNS TTL flush ≤60 s).

---

## 10. Deployment Automation

**Terraform** for provisioning (Vultr + Hetzner providers both have official tf modules):

```
terraform/
  modules/pop/         # one module, two backends
    vultr.tf           # provider "vultr"
    hetzner.tf         # provider "hcloud"
    cloud-init.yml.tpl # installs docker, wireguard, joins mesh
  envs/prod/
    pop-sao.tfvars     # provider=vultr, region=sao
    pop-fra.tfvars     # provider=hetzner, region=fsn1
    pop-iad.tfvars     # provider=hetzner, region=ash
```

**Ansible** for app rollout (`ansible-playbook pop.yml -l pop-sao`):

```
ansible/
  inventories/prod.yml
  roles/
    common/           # ufw, fail2ban, unattended-upgrades
    wireguard/        # join 10.88.0.0/24 mesh
    pg-replica/       # pg_basebackup from origin
    coturn/           # /etc/turnserver.conf templated
    livekit/          # multi-node config, region-tagged
    ws-cpp/           # systemd unit copy from origin
    nginx/            # TLS via certbot-dns-cloudflare
    monitoring/       # node + blackbox exporters
  playbooks/
    bootstrap.yml     # first-boot
    rollout.yml       # rolling app update
    drain.yml         # stop heartbeats, wait, shutdown
```

`scripts/pop-add.sh <region>` wraps Terraform apply + Ansible bootstrap. First-PoP-from-zero: ~12 min including PG basebackup.

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Vultr SP UDP throttling under DDoS | Med | High (BR users) | Have Magalu/Locaweb pre-provisioned as cold standby; DNS swap |
| Hetzner ToS view on real-time media | Low | Med | Section 4.3 of Hetzner ToS permits VoIP. Keep CPU <70 % avg. |
| PG replica lag during origin maintenance | Med | Med | PoPs accept stale auth up to 60 s; fail closed after that |
| WireGuard mesh partition | Low | High | Each PoP can fall back to public-internet SFU forwarding via TLS (same cert chain) |
| Cloudflare Worker free tier exhaustion | Low | Low | 100k req/day = ~3M/mo; cache geo result client-side 30 min |
| Geo-routing wrong for VPN users | High | Low | Client-side latency probe overrides DNS choice |
| Cost runaway on egress at 100k MAU | Med | Med | Force-switch to TCP/443 mode for users on poor networks (cheaper for us, worse for them); enable per-user monthly minute cap |
| Single-origin PG master is SPOF | High | High | Out of scope for this doc — covered by Agent 7 (HA) |
| ReplayKit / iOS callkit assumes one ws endpoint | Med | Med | Client builds endpoint from PoP-picker; already a TODO in `services/wsClient.js` |

---

## 12. Phased Rollout

1. **Week 1:** stand up `pop-fra` only; A/B 10 % of EU users by feature flag.
2. **Week 2:** add `pop-iad`, route US east-coast traffic.
3. **Week 3:** add `pop-sao`; this is the high-impact one (largest user base by far).
4. **Week 4:** enable cross-PoP relay; remove origin from media-plane DNS (origin stays HTTP/API only).
5. **Month 2+:** measure, then decide on Tokyo / Sydney.

**Exit criteria for declaring multi-PoP "done":** p50 RTT < 50 ms for ≥90 % of MAU, no single-PoP outage causes >5 min total app downtime, monthly infra cost < $80 at current MAU.
