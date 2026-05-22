# Continuous E2E Test Harness for Calls

Phase 0 implementation. Detects regressions like the 2026-05-19 C++ WS envelope-wrap bug (3 days undetected in prod, caught in 45s here).

## Quick start (local dev)

Prereq: prod-box-equivalent shell with SSH access to the emulator host.

```bash
# Run T1 only (the envelope-bug catcher), no APK build, no R2 upload
export EMUL_HOST=213.136.72.141
export EMUL_USER=root
export EMUL_SSHKEY=~/.ssh/id_ed25519_emul    # or: export SSHPASS=...

scripts/e2e/run-wave.sh \
  --scenarios T1 \
  --out /tmp/e2e-local \
  --no-upload --no-slack

# Read the verdict
jq . /tmp/e2e-local/verdict.json
jq . /tmp/e2e-local/T1/verdict.json
```

Run T1 + T7:

```bash
scripts/e2e/run-wave.sh --scenarios T1,T7 --no-upload --no-slack
```

Run a full wave (all 10, but T2-T6 and T8-T10 are stubs that exit SKIP):

```bash
scripts/e2e/run-wave.sh
```

## Files

| Path | Purpose |
|------|---------|
| `run-wave.sh` | Top-level orchestrator. Manages pools, parallelism, aggregation, R2 upload, Slack alert. |
| `scenarios/T1-*.sh` | Android→Android call, both foreground. **Implemented.** |
| `scenarios/T7-*.sh` | Live host publishes, viewer subscribes. **Implemented.** |
| `scenarios/T2-T6, T8-T10` | Stubs that exit SKIP with `failure_class=STUB`. |
| `lib/android-device.sh` | adb wrappers (login, fg, kill, tap, screencap, logcat-grep, wifi, screen-off). Shells through SSH to emulator host. |
| `lib/parse-lk-logs.sh` | Pulls `docker logs livekit` since wave start, extracts `participantJoined`/`trackPublished`/`iceRestart`/`egressStarted` to NDJSON. Includes `lk_wait_for` poller. |
| `lib/parse-cppws-logs.sh` | Pulls C++ WS log slice, detects `envelope_in` without matching `envelope_unwrap` → `ENVELOPE_NOT_UNWRAPPED`. Verdict JSON emitter. |

## How T1 catches the envelope bug

1. Both emuls foreground & logged in (apitest as caller, duarte as callee).
2. Background LK log tail starts at `t0`.
3. Caller fires `chatyy://e2e/call-start?to=duarte@chatyy.com.br&kind=audio` deep link (cooperative — the app exposes this only when QA build).
4. Within 8s we expect `participantJoined` for caller in LK log. Within 10s, same for callee.
5. If caller joined but callee did **not** → pull C++ WS log slice, scan with `cppws_check_envelopes`. If `envelope_in` appears for `chat_message` frames whose `cid` does **not** show up in any `unwrap data payload` line → emit verdict with `failure_class=ENVELOPE_NOT_UNWRAPPED`.

That single signal points operators straight at `/opt/chatyy-ws-cpp/src/envelope.cpp` instead of "users say calls are broken."

## How T7 verifies live broadcast

1. Host (apitest) fires `chatyy://e2e/live-start` → app calls `chat_live_start`, joins LK room as publisher.
2. We wait for `trackPublished` from host (video kind) within 12s.
3. Extract the room id from host's `participantJoined` event.
4. Viewer (duarte) fires `chatyy://e2e/live-watch?host=...` → joins same room.
5. Assert `participantJoined` for viewer in that room within 8s.
6. Hold 5s; if viewer drops (`participantLeft`) → fail `VIEWER_DROPPED` (suggests no subscribe / no frames).

## Required app-side hooks (cooperative test mode)

To keep this maintainable, the app exposes a handful of deep links **only when** built with `EAS_BUILD_PROFILE=preview` AND `E2E_MODE=1` env. These hooks bypass UI taps so we don't have to OCR-tap-coordinate (much flakier).

| Deep link | Action |
|-----------|--------|
| `chatyy://e2e/call-start?to=<email>&kind=<audio\|video>` | Same as tapping the call icon in chat with that user. |
| `chatyy://e2e/live-start?title=<>&visibility=<>` | Same as Live → Start. |
| `chatyy://e2e/live-watch?host=<email>` | Open the watch screen for that host's current live. |
| `chatyy://e2e/hangup` | T8 hangup hook. |
| `chatyy://e2e/wifi-flap` | T9 hook (alternative to `adb svc wifi disable`). |

Additionally, the app reads `/sdcard/qa_creds.json` on boot when `E2E_MODE=1` and auto-logs in.

These hooks are wired in `app/_layout.js` (Phase 1 work — not done yet; agents 3-4 will add them).

## Integration with `ship.sh` (Phase 1, deferred)

This phase does NOT modify `ship.sh`. The hooks for the gate are already in place:

- On `success` of every push-to-main wave, the workflow writes `SHA → /var/lib/e2e/last_green.txt` on the prod runner.
- Phase 1 will add to `ship.sh`:
  ```bash
  LAST_GREEN=$(cat /var/lib/e2e/last_green.txt 2>/dev/null || echo "")
  HEAD_SHA=$(git rev-parse HEAD)
  if [ "$LAST_GREEN" != "$HEAD_SHA" ] && [ -z "$SHIP_SKIP_E2E" ]; then
    echo "blocked: HEAD ($HEAD_SHA) is newer than last green E2E ($LAST_GREEN)"
    echo "        rerun the e2e-call-tests workflow or set SHIP_SKIP_E2E=1"
    exit 1
  fi
  ```
- Override: `SHIP_SKIP_E2E=1 scripts/ship.sh ios "hotfix"` — logged to Slack so the team knows the gate was bypassed.

## Failure dump structure

```
/tmp/e2e-run-<sha>/
  verdict.json                 # wave-level: status, duration_s, scenarios[]
  T1/
    verdict.json               # scenario-level: id, status, failure_class, ...
    stdout.log                 # full bash stdout of the scenario
    stderr.log
    lk-events.ndjson           # extracted LK lifecycle events
    lk-events.ndjson.raw       # raw docker logs livekit
    ws-cpp.log                 # C++ WS log slice
    cppws-verdict.json         # parsed: status + counts
    logcat-A.txt
    logcat-A-full.txt          # only on fail
    logcat-B.txt
    screen-A-pre.png
    screen-A-post.png
    screen-B-pre.png
    screen-B-post.png
  T7/...
```

On wave FAIL with `R2_BUCKET` env set, the orchestrator uploads the whole directory to `r2://chatyy-e2e/<yyyy-mm-dd>/<sha>/` and posts a Slack message linking it.

## Adding a new scenario

1. Create `scripts/e2e/scenarios/T11-<name>.sh` following the T1 template.
2. Add `T11` to either `POOL1` or `POOL2` in `run-wave.sh`.
3. Add a row to the catalog in `docs/whatsapp-migration/09-continuous-e2e-tests.md`.
4. The runner auto-discovers it via the `T<N>-*.sh` glob.

## Known limitations (Phase 0)

- Pool 2 currently runs sequentially after Pool 1 (single emul pair).
  Wave wall time is ~3-4 min for T1+T7 alone; full 10-scenario wave is ~10 min.
  Adding a third emul or wiring Mac 207 sim into pool 2 unblocks parallel pools.
- iOS sim scenarios (T4, T5) require Mac 207 to be online and the build cached.
- C++ WS envelope detection depends on the WS log emitting `cid=...` on both
  `recv envelope frame` and `unwrap data payload` lines. If those log lines
  change format, update `lib/parse-cppws-logs.sh`. Verified against the
  2026-05-19 incident log format.
- The cooperative deep links listed above are not yet implemented in the app.
  Without them, the scenarios will fail at the call-trigger step. Track in
  the Phase 1 ticket "wire E2E_MODE deep links."
