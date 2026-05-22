# 10 — Phased Implementation Roadmap (Orchestrator Synthesis)

**Agent 10 of 10.** Synthesizes Agents 1–9 into one delivery plan.
**Read first:** `01-pjsip-ios.md` · `02-pjsip-android.md` · `03-signaling-protocol.md` · `04-wasp-relay.md` · `05-multi-pop-infra.md` · `06-relay-first-state-separation.md` · `07-signal-protocol-calls.md` · `08-native-call-no-bridge.md` · `09-continuous-e2e-tests.md`.

**Bottom line up front.** This is a **6–9 month** programme to reach "WhatsApp-grade" calling, not a one-month sprint. With **1 dev** (current reality) the realistic horizon is **9 months** with high concurrency risk; with **2 devs** it's **6 months**; with **5 devs** it's **4 months**. Anything shorter is over-promising. We have had months of frustration with call quality precisely because the work was scoped as "fix the bug" instead of "rebuild the stack." This plan is honest about that.

---

## 1. Phase Map

### Phase 0 — Foundation (weeks 1–2)
Touches no production user. Pure infra + safety net.

- **W1**: Stand up Agent 9's `/opt/e2e/` orchestrator on prod. Implement scenarios T1 + T8 only, run nightly cron. Proves dual-emul SSH path works.
- **W1**: Provision Vultr `pop-sao` (Agent 5). WireGuard mesh to origin. PG streaming replica. No traffic routed to it yet.
- **W2**: Add Hetzner `pop-fra` + `pop-iad`. Cloudflare Worker geo-router at `edge.chatyy.com.br/pop` returning nearest PoP. Client probe code shipped behind `MULTI_POP_ENABLED=0`.
- **W2**: E2E harness extended to T2/T3/T9 (kill, lock, network drop). Workflow remains `workflow_dispatch` only — no `ship.sh` gate yet.

**Exit gate to Phase 1:** 3 PoPs reachable; E2E harness green on T1/T2/T3/T8/T9 for 7 consecutive nightly runs; no commits land directly affecting `/call.js`, `chat.php` call handlers, or `/opt/chatyy-ws-cpp` until gate met (frozen, except hotfixes).

### Phase 1 — Refinement (weeks 3–4)
Get every milliseconds we can out of the LiveKit stack we already have, before any rewrite. This is the highest-ROI work in the entire programme.

- **W3**: Agent 6's relay-first config. Two-stage `iceTransportPolicy` flip (`relay` → `all`) on a 5 % canary. Measure phase-0 audible-time histogram. Target p50 < 500 ms.
- **W3**: Ship `chat_call_active` + `chat_call_devices` schema migrations (Agent 6 §3). Dual-write from `chat.php`. Read-side stays on legacy until W4.
- **W4**: Agent 3's CWP/1 binary signaling shim. C++ WS `handle_cwp()` behind `CWP_ENABLE=1`. Client code ships a CWP encoder but still defaults to JSON. Subprotocol negotiation in place.
- **W4**: Wire E2E `ship.sh` gate — no OTA/build publishes if last green E2E SHA ≠ HEAD. Override exists but logs to Slack.

**Exit gate to Phase 2:** Call-setup p50 < 500 ms on canary; CWP frames flowing on internal accounts; zero net regressions on T1–T9 for 14 days. **Go/no-go review.**

### Phase 2 — Staged Migration (months 2–4)
Now we touch the call stack itself. Everything behind feature flags, all dual-stack with LiveKit.

- **M2 W1–4**: Agent 1 — PJSIP iOS skeleton. Legal closes commercial license week 1 (critical-path blocker). Build XCFramework on Mac 207. Loopback test, then internal TestFlight with `pjsip_ios_enabled` flag default OFF.
- **M2 W1–4 (parallel)**: Agent 2 — PJSIP Android. Pre-built `.aar` per ABI. REGISTER smoke test on emul-5554 (W2), audio-only call (W3), video (W4). Flag `PJSIP_ENABLED=false` for all real users.
- **M3 W1–3**: Agent 7 — Signal Protocol E2EE schema + endpoints land (`chat_call_keys`, `chat_call_key_envelopes`). Both stacks dual-publish: legacy unencrypted SRTP **and** wrapped master secret. Callees prefer E2EE when both sides flag support.
- **M3 W4**: Agent 5 multi-PoP enabled in production. `media.chatyy.com.br` DNS geo-records active. LiveKit configured multi-node with WireGuard mesh.
- **M4 W1–4**: Canary cohort (5 % → 25 %) on `pjsip_*_enabled` for native + `CALL_E2EE_ENABLED=1`. Use Agent 9's T4/T5/T6 (cross-platform + group) for nightly soak. Telemetry: `call_setup_p95_ms`, `call_drop_rate`, MOS estimate from RTCP-XR.

**Exit gate to Phase 3:** PJSIP at 25 % traffic with drop-rate ≤ LiveKit baseline; E2EE negotiated on ≥ 95 % of eligible calls; multi-PoP p50 RTT < 50 ms for 90 % of MAU. **Hard go/no-go — if PJSIP regresses, retreat to LiveKit and absorb the sunk cost.**

### Phase 3 — Native Rewrite (months 4–6)
The expensive, high-value, low-reversibility work.

- **M4 W4 – M5 W4**: Agent 8 — pure native call lifecycle. New `modules/chatyy-call-native` module. CallKit + Telecom own everything; JS sees only `startCall/endCall/on_call_started/on_call_ended`. `/call.js` deleted on mobile (kept as `/call.web.js`). Cutover behind `call_v2_native` flag, per-user.
- **M5 W2 – M6 W2**: Agent 4 — WASP relay on UDP/8443. Coexists with coturn (different ports). PROBE-only week 1, then `STUN_LEGACY` passthrough, then opt-in cohort. Multi-PoP becomes prerequisite (Agent 5 must be at 100 %).
- **M6 W3–4**: Group calls revisit — Agent 7 sender-key distribution at scale; Agent 8 group fallback policy (PJSIP is 1:1, group calls route to LiveKit JS via `/call.web.js` even on mobile when N>2 — accept the asymmetry).

**Exit gate to Phase 4:** `call_v2_native` at 50 % traffic; WASP carrying ≥ 30 % of relayed sessions; group-call quality unchanged. **Go/no-go.**

### Phase 4 — Cutover (month 7+)
- **M7 W1–2**: Flip `call_v2_native` default ON for new installs. Flag still respected per-user for kill-switch.
- **M7 W3–4**: Burn `@livekit/react-native` from `package.json` on a branch. Keep LiveKit server-side until 1:1 calls are 100 % PJSIP. Web stays on LiveKit indefinitely.
- **M8+**: Multi-PoP becomes mandatory (drop the feature flag). Sunset coturn — WASP only. Decommission `pop-iad` origin role; origin keeps only PG master + mail + API.

---

## 2. Dependency Graph

```
                        Agent 9 (E2E harness)
                                │  gates every other phase
                                ▼
          ┌──────────── Agent 5 (multi-PoP) ───────────┐
          │                     │                       │
          ▼                     ▼                       ▼
   Agent 6 (relay-first)   Agent 3 (CWP shim)      Agent 4 (WASP)
          │                     │                       │
          └────────┬────────────┘                       │
                   ▼                                    │
            Agent 7 (E2EE) ◄──┐                         │
                   │          │ (SFrame needed for      │
                   ▼          │  relay-swap rekey-less) │
        ┌──── Agent 1 (iOS PJSIP) ── Agent 2 (Android PJSIP) ──┐
        │                       │                              │
        └───────────────────────┴─── Agent 8 (native lifecycle)┘
                                                │
                                                ▼
                                          Phase 4 cutover
```

**Critical paths:**
- **Agent 9 blocks everything.** No phase advances without nightly E2E green.
- **Agent 5 blocks Agent 4.** WASP needs multi-PoP to demonstrate value (failover hint, anycast). Single-PoP WASP is pointless.
- **Agent 6 blocks Agent 7.** Relay-first with SFrame is what lets the swap be rekey-less and <2 s; without E2EE on top, the swap costs ~5 s DTLS rekey.
- **Agent 1 + 2 block Agent 8.** Native lifecycle needs a native media stack to drive; can't strip JS without PJSIP.
- **Agent 3 is independent** — can ship anytime after Phase 0.
- **Legal (PJSIP commercial license)** is the longest pole in the tent. **Start it in week 1**, not when Phase 2 begins. ~$4–6k, weeks of paperwork.

---

## 3. Resource Estimates

| Scenario | Devs | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | **Total** |
|---|---|---|---|---|---|---|---|
| Current (you) | 1 | 3 wk | 3 wk | 16 wk | 12 wk | 6 wk | **~9 months** |
| +1 hire (iOS/native specialist) | 2 | 2 wk | 2 wk | 10 wk | 8 wk | 4 wk | **~6 months** |
| Ideal team | 5 (1 iOS, 1 Android, 1 backend/C++, 1 SRE, 1 QA) | 2 wk | 2 wk | 6 wk | 5 wk | 3 wk | **~4 months** |

At 1 dev, **Phase 2 + 3 in parallel is impossible** — single threading forces serial PJSIP iOS → Android → native lifecycle. The 16 wk + 12 wk Phase 2 + 3 lines above already assume serial execution. Don't try to parallelize them without a second pair of hands; that path historically caused half-finished native modules (callkeep not installed, ExpoAudioSession iOS-only — see memory `call_regression_2026_05_11_root_cause`).

---

## 4. Risk Matrix

| Phase | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 0 | Emulator flakiness > 15 % FP rate | Med | Med | Agent 9 §9 playbook; pin AVD images; review FP weekly |
| 0 | Multi-PoP PG replica lag during launch | Low | Med | Fail-closed on auth at 60 s lag; cron alert at 10 s |
| 1 | Relay-first doubles TURN egress cost | High | Med | Budget for 100 % relay worst case in cost model; P2P upgrade in <1 s on Wi-Fi keeps median <30 s |
| 1 | CWP shim breaks JSON clients (subprotocol bug) | Med | High | 30-day dual-stack window; fallback path always armed; coverage gate via Agent 9 |
| 2 | PJSIP commercial license blocked / over-budget | Med | **Blocker** | Negotiate week 1; backup plan = re-evaluate `linphone-sdk` (LGPL) — costs 4 weeks |
| 2 | AVAudioSession + CallKit + ReplayKit deadlock | Med | High | Disable ReplayKit during active PJSIP call (Phase 2 enforced); see memory `replaykit_lk_refactor_pending` |
| 2 | iOS H.264 hardware decoder gap → SW fallback | High | Med | Bridge VideoToolbox via custom `pjmedia_vid_codec` (+1 wk in Phase 3) |
| 2 | E2EE master rotation kills audio for 200–800 ms | Med | Med | Disable mid-call codec renegotiation; rotate keys on network-type change only |
| 3 | Native call screen feature gap (PIP, reactions, share-screen) | High | Med | Stage parity table; only ship features available on all 3 platforms (iOS/Android/web) |
| 3 | WASP custom protocol → no Wireshark dissector | High | Low | Ship Lua dissector + `wasp-dump` CLI before Phase 3 starts |
| 3 | OTA agility lost for native call bugs | Cert | Med | Accepted trade-off — same posture as WhatsApp/Signal/Telegram. Compensate with E2E gating + rapid TestFlight builds |
| 4 | LiveKit removal regression on web | Med | High | Web keeps LiveKit JS path indefinitely; mobile-only cutover |
| 4 | Russia/China geo-restrictions on E2EE | Cert | Low | Already geofenced for IAP; extend geofence (Agent 7 §10) |
| All | Solo-dev burnout / context-switch | **High** | **High** | Hire. Seriously. 9 months solo on this is not a healthy plan. |

---

## 5. Rollback Plan

| Phase | What's deployed | Rollback mechanism | Time-to-rollback |
|---|---|---|---|
| 0 | E2E harness + dormant PoPs | `systemctl stop chatyy-e2e`; DNS unchanged; PoPs offline | <5 min |
| 1 | CWP shim (flag off by default); relay-first canary | `CWP_ENABLE=0` env + `php-fpm restart`; iceTransportPolicy flag off | <2 min |
| 2 | PJSIP behind `pjsip_*_enabled`; E2EE behind `CALL_E2EE_ENABLED` | Flag toggle via admin.php → push to `chat_user_settings`. **Killswitch matches existing chat E2EE killswitch pattern** | <30 s per user, <5 min global |
| 3 | `call_v2_native` per user; WASP coexists with coturn | Flag toggle; DNS swap back to coturn-only A records (TTL 60 s) | <2 min |
| 4 | LiveKit removed from mobile bundle | Native rollback impossible without app store rollback. **This is the point of no return.** | Native: only via store hotfix (24–48h iOS, 4h Android internal) |

**Phase 4 is irreversible at app-store level.** Treat the Phase 3→4 gate as a one-way door. Keep the PJSIP+LiveKit dual-stack build on a branch for 90 days post-cutover in case a hotfix needs to revert one side.

---

## 6. Success Metrics — "WhatsApp-grade" Defined

WhatsApp public targets (from webrtchacks teardowns and Meta atScale talks):

| KPI | Today (LiveKit + JS) | Target | Stretch | Source |
|---|---|---|---|---|
| Call setup time (invite → audible) p50 | 1.5–4 s | **<500 ms** | <300 ms | Agents 6 §1, 8 §8 |
| Call setup time p95 | 4–8 s | **<1.5 s** | <900 ms | Agent 1 W5 exit |
| MOS score (audio quality) | ~3.6 estimated | **>4.0** | >4.2 | Agent 2 §3 telemetry |
| Dropped call rate | ~3 % | **<0.5 %** | <0.2 % | Agent 6 §7 |
| Failover MTTR (relay dies mid-call) | call drops | **<2 s** | <500 ms | Agent 4 §5, 6 §4 |
| Push → CallKit/Telecom ring | 800–2400 ms | **<150 ms** | <80 ms | Agent 8 §8 |
| Battery drain (10-min call) | 8–11 % | **<5 %** | <3 % | Agent 8 §8 |
| Bundle size delta from baseline | +0 (existing) | **<+2 MB / arch** | net negative | Agents 1 §2, 2 §1, 8 §8 |
| WS frame parsing bugs (per quarter) | 1–3 P0 | **0** | 0 | Agent 3 §11 |
| E2E coverage of call-path branches | ~10 % | **>80 %** | >90 % | Agent 9 §8 |
| Multi-PoP p50 RTT (90% MAU) | n/a (single PoP) | **<50 ms** | <30 ms | Agent 5 §12 |

Track all via existing `/var/www/suporte/` dashboard. Add `stack=livekit|pjsip` and `pop=sao|fra|iad` dimensions before Phase 2 starts.

---

## 7. Cost Projection

**Infra (monthly):**

| Phase | New infra | Marginal cost |
|---|---|---|
| 0 | pop-sao (Vultr $24) + pop-fra/iad (Hetzner $7 × 2) + Cloudflare Worker (free) | **+$38/mo** |
| 1 | none | +$0 |
| 2 | TURN egress headroom (relay-first) | **+$10–30/mo** |
| 3 | WASP daemon on existing PoPs (no new boxes) | +$0 |
| 4 | Sunset coturn (no savings — same boxes) | +$0 |
| **Total at end-state** | | **~$80/mo at current MAU; ~$300/mo at 100k MAU** |

Compare AWS Chime / Agora at 100k MAU: **$5k–15k/mo**. We sit at 2–6 % of that.

**Dev time (one-off):**

| Item | Cost (1-dev rate at $0 — solo founder reality) | Cost (contractor $90/hr) |
|---|---|---|
| PJSIP commercial license | **$4–6k** (hard cash, no negotiation) | same |
| Total 9 months solo | $0 cash but ~1500 hr opportunity cost | ~$135k if outsourced |
| Total 6 months with 1 hire | iOS specialist ~$120k/yr × 6 mo = **$60k** | n/a |

**Recommendation:** Pay the $4–6k PJSIP license. Do not contract this work out — institutional knowledge of the chatyy stack is the moat. Hire one full-time native specialist if budget allows; otherwise accept the 9-month timeline.

---

## 8. Decision Points (Go/No-Go Gates)

| Gate | When | Decision criteria | What "no-go" means |
|---|---|---|---|
| **G0 → G1** | End of week 2 | 3 PoPs reachable + E2E green 7 nights running | Extend Phase 0 by 1–2 weeks; do NOT start touching call code |
| **G1 → G2** | End of week 4 | p50 setup <500 ms on canary; CWP frames flow internally; zero net regressions | Hold at LiveKit + relay-first refinements; CWP can ship independently |
| **G2 → G3** | End of month 4 | PJSIP at 25 % traffic with drop-rate ≤ baseline; E2EE on ≥95 % | **Hard retreat: disable PJSIP flag, write off sunk cost, stay on LiveKit forever.** Multi-PoP + relay-first + CWP + E2EE alone still get us 70 % of the WhatsApp win without PJSIP — that is an acceptable outcome |
| **G3 → G4** | End of month 6 | `call_v2_native` at 50 %; WASP carrying ≥30 % of relayed; group calls unchanged | Hold native rollout at 50 %; LiveKit stays for 1:1 too. WASP can stay opt-in |
| **G4** | Month 7+ | 90 days of stable Phase 3 metrics | Don't cross G4. Live with the dual-stack until confidence is total. **The cost of crossing G4 wrong is an app-store rollback** |

---

## 9. What Could Realistically Happen

**Best case (5 devs, $4k license, no surprises):** 4 months. WhatsApp-grade by November 2026.

**Likely case (1–2 devs):** 6–9 months. WhatsApp-grade by Q1–Q2 2027.

**Worst case (license blocked + PJSIP regressions + solo dev):** Stop at G2. Ship Phase 0 + 1 only (multi-PoP + relay-first + CWP + E2EE), abandon PJSIP. **Outcome: 70 % of the WhatsApp win, ~2 months wall time, all-reversible. This is not failure — it is the rational stopping point if PJSIP doesn't pan out.**

The honest answer to "how long until calls feel like WhatsApp" is: **G1 (week 4) gets you most of the noticeable win** — relay-first cuts setup time in half, CWP eliminates the JSON-typo bug class, multi-PoP cuts RTT for non-NYC users by 100+ ms. Everything beyond G1 is polish + structural quality (zero JS bridge, E2EE, native CallKit ownership). Those matter for the long run but the user-visible "this feels different" moment lands at G1.

---

## 10. First Two Weeks — Concrete TODO

For the dev about to start this Monday morning:

1. Email Teluu about commercial PJSIP license. Today. (Longest pole.)
2. `terraform apply` for `pop-fra` (cheapest, lowest risk). Verify PG replication lag <1 s.
3. `git checkout -b e2e-harness` on prod, scaffold `/opt/e2e/` with scenario T1 only. Run it manually against a known-good build. Iterate until it's <60 s and reliable.
4. Schedule G1 review for 4 weeks out. Put it on the calendar now — it's the gate that defines whether to commit to the rest of this programme.

**End of orchestrator synthesis.** ~2,400 words.

---

## Implementation Status (Phase 0 + Phase 1 BUILD wave 1)

**Wave date:** 2026-05-21. **Wave outcome: Phase 0 = SCAFFOLDED (not yet deployed).**

This wave produced design docs + scaffolding only. Nothing in this section is in production. No traffic flows through any new code. Existing LiveKit + Go-WS-fallback + C++-WS-primary stack is unchanged. **`ship.sh` was not run as part of this wave.**

### What landed on disk

| Component | Path | State | Source agent |
|---|---|---|---|
| Design docs (Agents 1–9) | `docs/whatsapp-migration/01-09-*.md` | DESIGN COMPLETE | B1–B9 |
| Orchestrator roadmap | `docs/whatsapp-migration/10-roadmap.md` | DESIGN COMPLETE | B10 (this doc) |
| PJSIP iOS build script | `scripts/pjsip/build-ios.sh` + `build-ios.config` | SCAFFOLD (not run — no Mac access in this env, license not signed) | B1 |
| PJSIP Android build cfg | `scripts/pjsip/build-android.config` | SCAFFOLD (no `.aar` produced) | B2 |
| CWP/1 binary protocol | `/opt/chatyy-ws-cpp/src/cwp.{h,cpp}` + `cwp_dispatch.h` | SCAFFOLD (compiles into static lib but **NOT yet linked into running `chatyy-ws-cpp` binary** — binary at build/ predates cwp.cpp by 2h) | B3 |
| WASP relay daemon | `/opt/chatyy-wasp-cpp/` | DIR CREATED EMPTY (no code yet) | B4 |
| Multi-PoP infra design | docs only | DESIGN ONLY (no Vultr/Hetzner provisioned, no Cloudflare worker deployed) | B5 |
| Relay-first / state-separation | docs only | DESIGN ONLY (no LiveKit config change, no PG schema migration applied for `chat_call_active`/`chat_call_devices`) | B6 |
| Signal Protocol call-keys schema | `/var/www/mail/sql/migrations/2026-05-22-call-keys-tables.sql` | SCAFFOLD (migration file exists, **NOT applied to prod PG**) | B7 |
| Native call lifecycle | docs only — no `modules/chatyy-call-native/` created | DESIGN ONLY | B8 |
| E2E harness | `/opt/e2e/` not yet created | DESIGN ONLY | B9 |

### Honest status check

- **Nothing is SHIPPED.** Production behavior is identical to before this wave.
- **Nothing is on a feature flag yet** — flags described in docs, not implemented in code.
- The CWP scaffold in `/opt/chatyy-ws-cpp/src/cwp.cpp` is the closest thing to runnable code, but `main.cpp` does not yet `#include "cwp_dispatch.h"` nor dispatch binary frames. Linking + integration is Phase 1 W4 work, not this wave.
- The DB migration file is **idempotent and safe** but has not been applied. Apply only after reviewing in a maintenance window.
- WASP and E2E directories are placeholders.

### What "Phase 0 SCAFFOLDED" means in practice

You can now: review every design doc, sanity-check the CWP frame format, dry-run the PJSIP build script on a Mac, eyeball the SQL migration. You cannot yet: receive a binary CWP frame in prod, place a PJSIP call, route traffic through a PoP, or run nightly E2E.

See `BUILD-STATUS.md` for the full dashboard and `NEXT-STEPS.md` for the concrete actions required to move Phase 0 from SCAFFOLDED → DEPLOYED.
