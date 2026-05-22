# NEXT-STEPS — Concrete actions to advance Phase 0 from SCAFFOLDED → DEPLOYED

**Audience:** the founder/operator (you).
**Generated:** 2026-05-21 by Agent 10 after Wave 1 of the WhatsApp-stack migration.
**Status going in:** all design docs done · scaffolding committed · zero traffic touched.

This file is a checklist of the *next* batch of work. Each item is annotated **MANUAL** (you do it) or **AUTOMATED** (handled by ship.sh / cron / next agent wave). Stop and review the doc(s) referenced before doing each item.

---

## P0 — Do this week (blockers for Phase 1 start)

### 1. ☐ MANUAL — Get Teluu PJSIP commercial license quote (~$4–6k)
- **Why:** Phase 2 cannot start without it. **This is the longest pole** in the entire programme (weeks of paperwork).
- **How:** Email Teluu at **info@teluu.com** with subject `"Commercial license inquiry — Chatyy Super App (closed-source iOS+Android RN app)"`. Mention you want PJSIP 2.14.x for iOS+Android, distributed in a closed-source IPA/AAB. Ask for: per-product license, royalty terms (or flat fee), and whether their license covers redistribution via Apple/Google.
- **Owner:** founder. Cannot be done by agents.
- **Background:** see `01-pjsip-ios.md` §License and `10-roadmap.md` §4 Risk Matrix.

### 2. ☐ MANUAL — Provision Hetzner Frankfurt PoP
- **Why:** Multi-PoP is the foundation for Agent 4 (WASP) and Agent 6 (relay-first). Frankfurt is cheapest ($7/mo) and lowest risk.
- **How:**
  ```bash
  # Once `scripts/pop-add.sh` lands (next agent wave):
  scripts/pop-add.sh frankfurt
  # For now, do it manually via Hetzner Cloud Console:
  #   - cx21 (2 vCPU / 4 GB RAM) in fsn1
  #   - Ubuntu 26.04 LTS
  #   - SSH key: your existing chatyy-build key
  #   - After boot: install wireguard, peer to origin (217.216.67.99)
  #   - Verify PG streaming replica lag < 1 s (see 05-multi-pop-infra.md §4)
  ```
- **Cost:** ~$7/mo Hetzner.
- **Validation:** `ping -c 5 pop-fra.chatyy.com.br` from EU client < 30 ms.

### 3. ☐ MANUAL — Review then apply the call-keys DB migration
- **Why:** Agent 7's `chat_call_keys` / `chat_call_key_envelopes` / `chat_call_sender_keys` are forward-compatible and need to exist before any PJSIP+E2EE work. **Read the migration first** — it's idempotent but adds 3 tables and 6 indexes.
- **File:** `/var/www/mail/sql/migrations/2026-05-22-call-keys-tables.sql`
- **How:**
  ```bash
  # On prod (217.216.67.99):
  sudo -u postgres psql chatyy < /var/www/mail/sql/migrations/2026-05-22-call-keys-tables.sql
  # Record application:
  sudo mkdir -p /var/www/mail/sql/applied
  sudo touch /var/www/mail/sql/applied/2026-05-22-call-keys-tables.applied
  # Verify:
  sudo -u postgres psql chatyy -c "\dt chat_call*"
  ```
- **Rollback (if needed):**
  ```sql
  DROP TABLE IF EXISTS chat_call_sender_keys, chat_call_key_envelopes, chat_call_keys;
  ```
- **Risk:** very low — new tables, no schema changes to existing tables, no triggers.

### 4. ☐ MANUAL — Build and restart `chatyy-ws-cpp` to include the new CWP module
- **Why:** Agent 3's `cwp.{h,cpp}` + `cwp_dispatch.h` are on disk in `/opt/chatyy-ws-cpp/src/` but the running binary at `/opt/chatyy-ws-cpp/build/chatyy-ws-cpp` was built **before** these files (mtime 19:31 vs source 21:51). The new code is dead until we relink.
- **Caveat:** `main.cpp` does **NOT yet** `#include "cwp_dispatch.h"` nor wire frames through `dispatch_to_json`. That integration is Phase 1 W4 work, not this wave. Until then, a rebuild only includes the new symbols as unreferenced object code — the protocol is NOT active. **Do not advance BUILD-STATUS.md "CWP" beyond SCAFFOLD until the wiring is done.**
- **How (once integration patch lands):**
  ```bash
  cd /opt/chatyy-ws-cpp
  scripts/build.sh                              # CMake + ninja
  sudo systemctl restart chatyy-ws-cpp          # restart service
  sudo journalctl -u chatyy-ws-cpp -n 50 --no-pager | tail
  curl -s http://127.0.0.1:8083/health | jq .   # should report cwp=enabled
  # Smoke test from a CWP-aware client (or the unit test):
  cd /opt/chatyy-ws-cpp && ./tests/test_cwp_roundtrip
  ```
- **Rollback:**
  ```bash
  sudo systemctl stop chatyy-ws-cpp
  cp /opt/chatyy-ws-cpp/build/chatyy-ws-cpp.bak.20260521164324 /opt/chatyy-ws-cpp/build/chatyy-ws-cpp
  sudo systemctl start chatyy-ws-cpp
  ```

### 5. ☐ MANUAL — `/opt/chatyy-wasp-cpp/` is empty — leave alone for now
- The directory exists (placeholder) but Agent 4 produced design only. **No code to build yet.** Do not run any build/restart commands against `/opt/chatyy-wasp-cpp/`.
- WASP daemon work is Phase 3 (months 5–6). Don't pre-create systemd units.

---

## P1 — Do this month (Phase 0 → Phase 1 transition)

### 6. ☐ AUTOMATED (next agent wave) — Scaffold `/opt/e2e/` orchestrator
- Currently no E2E harness. Next agent wave should create `/opt/e2e/run.sh`, scenarios `t1`/`t8`, and a `chatyy-e2e.timer` systemd unit.
- Until that lands, **manual QA is the only safety net** — be cautious with any merges to `app/call.js` or `chat.php` call handlers.

### 7. ☐ AUTOMATED — Next `scripts/ship.sh` will include feature flags
- **Defaults OFF** for all new components: `CWP_ENABLE=0`, `MULTI_POP_ENABLED=0`, `CALL_E2EE_ENABLED=0`, `pjsip_*_enabled=false`.
- Safe to ship the next batch (scaffolded modules, dormant flags) via `scripts/ship.sh ota "wave 1 scaffolding + dormant flags"` once the wiring patch lands and migration #3 above is applied.
- The new ship.sh pre-flight reads `BUILD-STATUS.md` and warns if SHIPPED items lose their critical files. **Currently no SHIPPED items, so it's silent.** Will start firing as components ship.

### 8. ☐ MANUAL — Schedule G1 review for 4 weeks out
- Per roadmap §8, the **Phase 1 → Phase 2** go/no-go gate is at the end of week 4. Put it on the calendar now (target: 2026-06-18).
- Criteria to evaluate at G1:
  - 3 PoPs reachable, PG replica lag < 1 s
  - E2E harness green 7 nights running on T1, T2, T3, T8, T9
  - p50 call-setup time < 500 ms on relay-first canary
  - Zero net regressions on existing 1:1 LiveKit calls

---

## P2 — Awareness items (don't act yet)

- **Phase 4 is irreversible** at the app-store level. Reread roadmap §5 *Rollback Plan* before crossing G3.
- **Solo-dev burnout** is the highest-rated risk in the matrix. Seriously consider hiring an iOS/native specialist before starting Phase 2 (per §3).
- **License timing:** if Teluu negotiation runs > 4 weeks, the Phase 1 → Phase 2 gate slips by exactly that delta. Don't compress Phase 1 to compensate.
- **Russia/China geo-restrictions** on E2EE call keys — Agent 7 §10 has the geofence list; reuse the same gate logic as IAP geofences.

---

## Reference

- **Authoritative tickbox table:** `BUILD-STATUS.md`
- **Always-current state:** `scripts/check-migration-progress.sh` (read-only, safe anytime)
- **Roadmap:** `10-roadmap.md` (top of `docs/whatsapp-migration/`)
- **Per-agent designs:** `01-pjsip-ios.md` … `09-continuous-e2e-tests.md`

If you find yourself wondering "is X already deployed?" — run `scripts/check-migration-progress.sh` first. The script tells the truth; the markdown sometimes lags.
