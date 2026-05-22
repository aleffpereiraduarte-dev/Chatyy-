# BUILD-STATUS — WhatsApp-stack Migration Dashboard

**Single source of truth for "what stage is each component at?"**
**Generated:** 2026-05-21 by Agent 10 (orchestrator).
**Refresh via:** `scripts/check-migration-progress.sh`

Legend:
- `DESIGN`     — markdown design doc exists and is reviewed
- `SCAFFOLD`   — file/dir scaffolding exists on disk, may compile, NOT wired in
- `IMPLEMENTED` — fully wired into a runnable artifact, but behind feature flag OFF in prod
- `TESTED`     — passes E2E harness (T1–T9 as applicable)
- `SHIPPED`    — deployed to production via `scripts/ship.sh` AND enabled for ≥1 real user

A component is at the **highest** column with a `[x]`. Lower-column boxes may or may not be ticked once a higher box ticks.

---

## Phase 0 — Foundation

| Component | DESIGN | SCAFFOLD | IMPLEMENTED | TESTED | SHIPPED | Critical files |
|---|---|---|---|---|---|---|
| E2E harness (Agent 9) | [x] | [ ] | [ ] | [ ] | [ ] | `/opt/e2e/` (not created) · `docs/whatsapp-migration/09-continuous-e2e-tests.md` |
| Multi-PoP infra (Agent 5) | [x] | [ ] | [ ] | [ ] | [ ] | `docs/whatsapp-migration/05-multi-pop-infra.md` · `scripts/pop-add.sh` (not created) |
| ship.sh pre-flight | [x] | [x] | [x] | [ ] | [ ] | `scripts/ship.sh` (gated check added 2026-05-21) |

## Phase 1 — Refinement

| Component | DESIGN | SCAFFOLD | IMPLEMENTED | TESTED | SHIPPED | Critical files |
|---|---|---|---|---|---|---|
| Relay-first config (Agent 6) | [x] | [ ] | [ ] | [ ] | [ ] | `docs/whatsapp-migration/06-relay-first-state-separation.md` |
| `chat_call_active` / `chat_call_devices` schema | [x] | [ ] | [ ] | [ ] | [ ] | (migration file not yet authored) |
| CWP/1 binary protocol (Agent 3) | [x] | [x] | [ ] | [ ] | [ ] | `/opt/chatyy-ws-cpp/src/cwp.{h,cpp}` · `cwp_dispatch.h` — **NOT linked into running `chatyy-ws-cpp` binary** |
| ship.sh E2E gate | [x] | [ ] | [ ] | [ ] | [ ] | `scripts/ship.sh` (gate not added — warning-only pre-flight only) |

## Phase 2 — Staged Migration

| Component | DESIGN | SCAFFOLD | IMPLEMENTED | TESTED | SHIPPED | Critical files |
|---|---|---|---|---|---|---|
| PJSIP iOS XCFramework (Agent 1) | [x] | [x] | [ ] | [ ] | [ ] | `scripts/pjsip/build-ios.sh` · `build-ios.config` · **`vendor/pjsip-ios/PJSIP.xcframework` not built (no Mac runner here)** |
| PJSIP Android `.aar` (Agent 2) | [x] | [x] | [ ] | [ ] | [ ] | `scripts/pjsip/build-android.config` · `build-android.sh` not authored |
| Call E2EE schema (Agent 7) | [x] | [x] | [ ] | [ ] | [ ] | `/var/www/mail/sql/migrations/2026-05-22-call-keys-tables.sql` — **NOT applied to prod PG** |
| Call E2EE PHP endpoints | [x] | [ ] | [ ] | [ ] | [ ] | `chat.php` handlers (not authored) |
| Multi-PoP DNS geo-records | [x] | [ ] | [ ] | [ ] | [ ] | Cloudflare zone — not changed |

## Phase 3 — Native Rewrite

| Component | DESIGN | SCAFFOLD | IMPLEMENTED | TESTED | SHIPPED | Critical files |
|---|---|---|---|---|---|---|
| Native call lifecycle (Agent 8) | [x] | [ ] | [ ] | [ ] | [ ] | `modules/chatyy-call-native/` — not created |
| WASP relay daemon (Agent 4) | [x] | [x] | [ ] | [ ] | [ ] | `/opt/chatyy-wasp-cpp/` — directory exists but **EMPTY** |
| Sender-key distribution (group E2EE) | [x] | [x] | [ ] | [ ] | [ ] | `chat_call_sender_keys` row in migration above |

## Phase 4 — Cutover

| Component | DESIGN | SCAFFOLD | IMPLEMENTED | TESTED | SHIPPED | Critical files |
|---|---|---|---|---|---|---|
| `call_v2_native` flag default ON | [x] | [ ] | [ ] | [ ] | [ ] | — |
| LiveKit removal from mobile bundle | [x] | [ ] | [ ] | [ ] | [ ] | `package.json` — `@livekit/react-native` still present |
| WASP-only relay | [x] | [ ] | [ ] | [ ] | [ ] | — |

---

## Aggregate

| Phase | Components | DESIGN | SCAFFOLD | IMPLEMENTED | TESTED | SHIPPED |
|---|---|---|---|---|---|---|
| Phase 0 | 3 | 3 | 1 | 1 | 0 | 0 |
| Phase 1 | 4 | 4 | 1 | 0 | 0 | 0 |
| Phase 2 | 5 | 5 | 3 | 0 | 0 | 0 |
| Phase 3 | 3 | 3 | 1 | 0 | 0 | 0 |
| Phase 4 | 3 | 3 | 0 | 0 | 0 | 0 |
| **TOTAL** | **18** | **18** | **6** | **1** | **0** | **0** |

**Wave 1 outcome:** 100% DESIGN coverage, 33% SCAFFOLD coverage, 0% SHIPPED. This is the expected baseline after a design-and-scaffold wave. See `NEXT-STEPS.md` to advance.

---

## Critical files referenced by ship.sh pre-flight

If any item below claims "SHIPPED" in this file, ship.sh will verify the corresponding critical file exists at deploy time. Currently zero items are SHIPPED, so no file checks fire.

| Component | If SHIPPED, ship.sh checks |
|---|---|
| CWP/1 binary protocol | `/opt/chatyy-ws-cpp/src/cwp.cpp` AND `/opt/chatyy-ws-cpp/build/chatyy-ws-cpp` newer than `cwp.cpp` |
| Call E2EE schema | `/var/www/mail/sql/migrations/2026-05-22-call-keys-tables.sql` applied (marker file `/var/www/mail/sql/applied/2026-05-22-call-keys-tables.applied`) |
| PJSIP iOS | `vendor/pjsip-ios/PJSIP.xcframework/Info.plist` |
| PJSIP Android | `android/app/libs/pjsip-*.aar` |
| E2E harness | `/opt/e2e/run.sh` AND systemd timer `chatyy-e2e.timer` enabled |
| Multi-PoP | DNS records for `media.chatyy.com.br` resolve to >1 IP |
| Native call lifecycle | `modules/chatyy-call-native/expo-module.config.json` |
| WASP relay | `/opt/chatyy-wasp-cpp/build/wasp-relay` exists and `systemctl is-active chatyy-wasp` |

Run `scripts/check-migration-progress.sh` to re-evaluate every column in real time against the actual filesystem and DB state.
