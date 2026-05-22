# 09 — Continuous E2E Test Harness for Calls

**Owner:** Agent 9 of 10
**Status:** Design (pre-implementation)
**Goal:** Catch bugs like the C++ WS envelope-wrap regression (3 days undetected, 8 min to find with a dual-emul agent) BEFORE they ship. Every commit to `main` runs a 10-min wave across 10 scenarios on real Android emulators + iOS sim, with auto-rollback gating on `ship.sh`.

---

## 1. Architecture

```
                   GitHub push to main
                            |
                            v
              +--------------------------+
              | GH Actions (self-hosted) |
              | runner on prod 217...99  |
              +-----------+--------------+
                          |
              builds APK (eas --local on Mac 207 via Tailscale)
                          |
                          v
              +--------------------------+
              |   e2e-orchestrator.py    |
              |   (prod, /opt/e2e/)      |
              +---+-------+--------+-----+
                  |       |        |
       adb over   |       |        |   ssh tunnel
       Tailscale  |       |        |
                  v       v        v
           +---------+ +-------+ +---------+
           | EMUL-A  | |EMUL-B | | iOS Sim |
           | 5554    | | 5556  | | Mac 207 |
           | 213.... | |213... | |100.103..|
           +----+----+ +---+---+ +----+----+
                |          |          |
                +----------+----------+
                           |
                           v (signals/RTC)
                   +---------------+
                   | ws.chatyy.com |  <-- C++ WS (logs scraped)
                   | livekit.cha.. |  <-- LK (REST + logs scraped)
                   | chatyy.com.br |  <-- PHP API (PG state read)
                   +---------------+
                           |
                           v
                   +---------------+
                   | Verdict & R2  |  pass/fail + dumps -> R2
                   | (Slack hook)  |  -> regression Slack alert
                   +---------------+
```

Hosts:

- **e2e orchestrator host**: `217.216.67.99` (prod). New systemd unit `chatyy-e2e.service` (manual / CI-triggered, not on timer).
- **Emulator host**: `213.136.72.141` (existing, root / SSH, 2 AVDs auto-running: `emul-5554`, `emul-5556`).
- **iOS sim host**: `100.103.47.109` (Mac 207 over Tailscale).
- **GH Actions runner**: existing `ghrunner` self-hosted on prod (already used for Android local builds).

Why prod-as-orchestrator: it already SSHs to emul + Mac 207, holds the WS/LK/PG creds, and reaches the C++ WS log files at `/opt/chatyy-ws-cpp/logs/`. No new firewall holes.

---

## 2. Test Scenario Catalog

Each scenario is an isolated Python class under `/opt/e2e/scenarios/`. All run against the QA pair `apitest@onemundo.com.br` (caller) and `duarte@chatyy.com.br` (callee). Each scenario produces `{id, status, duration_ms, evidence_dir}`.

| ID  | Name | Setup | Action | Pass criteria | Budget |
|-----|------|-------|--------|---------------|--------|
| T1  | Android→Android, both foreground | Both emuls launched, app fg, on `/chat` | Caller taps call icon | LK `participant_joined` for both within 5 s; both screens show in-call UI; `track_published` audio for both | 45 s |
| T2  | Callee app killed, FCM wake | Emul-B `am force-stop com.chatyy`; emul-A foreground | Caller initiates | FCM payload in emul-B logcat; `IncomingCallActivity` fullscreen-intent fires; LK joined within 12 s | 60 s |
| T3  | Callee screen locked | Emul-B `input keyevent 26`, screen off | Caller initiates | Wake lock acquired (`PowerManager` in logcat); call UI on top of keyguard; audio track flowing | 60 s |
| T4  | Android→iOS sim | Mac 207 sim booted, app fg | Android caller | LK joined; APNs VoIP push in `xcrun simctl push` log; CallKit UI visible (screenshot OCR) | 75 s |
| T5  | iOS sim→Android | Reverse of T4 | iOS caller | Android `call_invite` received in emul-A; LK joined | 75 s |
| T6  | Group call 3 participants | Add a 3rd headless emul on prod via `qemu-system` lite (or use Mac 207 sim as #3) | Caller invites both | LK room shows 3 `participant_joined`; each sees 2 remote video tiles | 90 s |
| T7  | Live broadcast | Host = emul-A `chat_live_start`; viewer = emul-B opens watch screen | n/a (passive watch) | LK egress publisher; viewer subscribes; first frame within 6 s | 60 s |
| T8  | Call end cleanup | Run T1, then caller hangs up | n/a | `call_end` WS event both sides; UI dismissed within 2 s; LK `participant_left`; PG `chat_calls.ended_at` populated | 30 s |
| T9  | Network drop + reconnect | Run T1, then `adb shell svc wifi disable` on emul-A for 10 s, re-enable | n/a | WS reconnect; LK ICE restart; call resumes within 30 s | 60 s |
| T10 | Load: 1000 invites / 60 s | Same QA pair, scripted via direct `call_invite` HTTP loop (no UI taps) | n/a | C++ WS RSS stays <80 MB; >99 % delivered; p99 invite→ring <800 ms | 90 s |

**Total wall budget**: ~10 min when run in parallel waves (T1-T5 first, T6-T10 second).

**Specifically catches the envelope bug:** T1 fails fast — if C++ WS wraps `chat_message` inside the envelope frame instead of unwrapping `data`, emul-B never receives `call_invite` and times out at the 5 s mark.

---

## 3. adb Automation Skeleton

`/opt/e2e/lib/device.py`:

```python
class AndroidDevice:
    def __init__(self, host, serial):       # host=213.136.72.141, serial=emulator-5554
        self.adb = f"ssh root@{host} adb -s {serial}"
    def install(self, apk):                 # rsync apk -> emul host /tmp -> adb install -r
    def login(self, email, pwd):            # writes /sdcard/qa_creds.json, app reads on boot
    def fg(self, activity="MainActivity"):  # am start -n com.chatyy/.MainActivity
    def kill(self):                         # am force-stop com.chatyy
    def tap(self, x, y):                    # input tap (use uiautomator dump for resource-id lookup)
    def tap_id(self, resource_id):          # uiautomator dump | grep -> tap coords
    def logcat_since(self, t0, tags):       # adb logcat -d -t <t0> <tags>
    def screencap(self, dest):              # adb exec-out screencap -p > dest.png
    def wifi(self, on: bool):               # svc wifi enable|disable
    def screen_off(self):                   # input keyevent 26
    def unlock(self):                       # input keyevent 82
```

Reachability: GH runner on prod already has `~/.ssh/id_ed25519_emul` (existing for [[android_emulator_server]]). No `adb connect` over WAN — we shell into the emul host and run `adb` there.

`iOSDevice` analogous via `xcrun simctl` over SSH to Mac 207.

---

## 4. LiveKit Log Parsing

LK self-hosted logs land in `/var/log/livekit/livekit.log` (JSON-lines). The orchestrator tails since `t0` and matches:

```
participant_joined : "participantJoined" .* "identity":"<email>" .* "room":"<room_id>"
participant_left   : "participantLeft"   .* "identity":"<email>"
track_published    : "trackPublished"    .* "kind":"(audio|video)" .* "participant":"<email>"
ice_restart        : "iceRestart"        .* "participant":"<email>"
egress_started     : "egressStarted"     .* "roomName":"<room>"   # T7 only
```

Python regex catalog in `/opt/e2e/lib/lk_log.py`, exposing `wait_for(event, identity, room, timeout_s)`.

C++ WS log parser (`/opt/chatyy-ws-cpp/logs/ws.log`) checks for the envelope-bug signature:

```
envelope_in     : 'recv envelope frame' .* 'type=chat_message'
envelope_unwrap : 'unwrap data payload' .* 'inner_type=call_invite'   # this line is the fix
broadcast_skip  : 'no subscribers for channel'                        # red flag when expecting delivery
```

If `envelope_in` appears but `envelope_unwrap` does not → automatic fail with class `ENVELOPE_NOT_UNWRAPPED`.

---

## 5. Verdict Engine

Per scenario:

1. **Hard signals** (must all hold): LK events match, logcat shows expected lifecycle, no crash (`AndroidRuntime` FATAL).
2. **Soft signals**: OCR of screencap via `tesseract` finds expected strings (`"Conectado"`, `"00:0"`, callee display name). OCR is advisory only — failure here logs a warning but does not fail the wave (mitigates flakiness, keeps FP <5 %).
3. **State signals**: query PG `chat_calls` for the row created in this run; assert `status='ended'` for T8.

Verdict = `PASS` iff all hard + state signals pass. Else `FAIL` with a `failure_class` enum (`WS_TIMEOUT`, `LK_NO_JOIN`, `UI_NOT_VISIBLE`, `CRASH`, `ENVELOPE_NOT_UNWRAPPED`, `FCM_NOT_RECEIVED`, ...).

---

## 6. CI Integration

`.github/workflows/e2e-calls.yml` (skeleton):

```yaml
name: e2e-calls
on:
  push: { branches: [main] }
  workflow_dispatch:
jobs:
  wave:
    runs-on: [self-hosted, prod]
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Build APK (Mac 207 over Tailscale)
        run: ssh administrator@100.103.47.109 'cd ~/apps/chatyy && eas build -p android --local --profile preview --non-interactive'
      - name: Fetch APK
        run: scp administrator@100.103.47.109:~/apps/chatyy/build-*.apk /tmp/chatyy.apk
      - name: Run wave
        run: /opt/e2e/run_wave.py --apk /tmp/chatyy.apk --scenarios T1..T10 --out /tmp/e2e-run-${{ github.sha }}
      - name: Upload dumps on failure
        if: failure()
        run: /opt/e2e/upload_dumps.sh /tmp/e2e-run-${{ github.sha }}   # -> R2 bucket chatyy-e2e
      - name: Slack notify on failure
        if: failure()
        run: /opt/e2e/notify.sh "$GITHUB_SHA" "$(cat /tmp/e2e-run-${{ github.sha }}/verdict.json)"
```

`ship.sh` gate: before any `eas submit` / OTA publish, `ship.sh` reads the last green SHA from `/var/lib/e2e/last_green.txt` and aborts if `HEAD` is newer. Override with `SHIP_SKIP_E2E=1` (logged to Slack).

---

## 7. Failure Dump Format

On any FAIL the orchestrator writes:

```
/tmp/e2e-run-<sha>/
  verdict.json                # {scenarios:[{id,status,failure_class,duration_ms}], commit, build_id}
  T1/
    logcat-A.txt              # since t0, all tags
    logcat-B.txt
    ws-cpp.log                # ws.log slice [t0-2s, t_end+2s]
    livekit.log
    pg-state.json             # chat_calls + chat_messages rows touched
    screen-A-pre.png          # before tap
    screen-A-post.png         # 3 s after tap
    screen-B-incoming.png
    timeline.txt              # merged event timeline, t-relative
  T1/diff.txt                 # delta vs last green run (regex-level)
```

Uploaded to `r2://chatyy-e2e/<yyyy-mm-dd>/<sha>/` with 30-day retention. Slack message links the verdict + per-scenario timeline.

---

## 8. Coverage Tracking

Coverage = (call-path branches exercised by passing scenarios) / (total call-path branches in `services/call.js` + `chat.php` `case 'call_*'` + C++ WS `handle_call_*`). Counted by `nyc` (JS) + `gcov` (C++) + a hand-curated PHP branch list (~40 branches).

- Baseline (day 0): T1+T8 cover ~22 %.
- Day 7 (T1-T5, T8, T9): ~55 %.
- Day 30 target: ≥80 % after adding T6, T7, T10 + 4 ad-hoc regression scenarios from real prod incidents.

Coverage report posted to PR as a comment on each push to a feature branch.

---

## 9. Emulator Flakiness Mitigation

Known failure modes and the playbook:

- **AVD frozen / black screen** → orchestrator pings `adb shell getprop sys.boot_completed`; if not `1`, `adb emu kill` + `emulator -avd chatyy_qa -no-window -no-audio -gpu swiftshader_indirect &` and wait 60 s.
- **adb daemon stale** → `adb kill-server && adb start-server` once per wave start.
- **APK install race** → install on both emuls in parallel, then `pm clear com.chatyy` + relaunch (clean state per wave).
- **Time skew** → `adb shell date` checked vs prod NTP; if drift >2 s, sync via `adb root && date -s`.
- **FCM token reuse** → after each wave, `/opt/e2e/reset_qa_push_tokens.sh` wipes `push_tokens/tokens.json` for both QA accounts so T2 always exercises fresh registration.
- **Retry policy** → each scenario gets at most one auto-retry on `INFRA_FAILURE` class (emul not booted, ssh timeout). Real call failures never retry — we want the signal.

Estimated FP rate after mitigations: ~3 % (vs raw ~15 %). Tracked in `/var/lib/e2e/fp_log.json` and reviewed weekly.

---

## 10. Rollout Plan

1. **Week 1** — Stand up `/opt/e2e/` skeleton + T1 + T8 only. Run nightly cron, not on every commit. Goal: prove dual-emul SSH path is reliable.
2. **Week 2** — Add T2, T3, T9. Wire GH Actions workflow as `workflow_dispatch` only (manual).
3. **Week 3** — Add T4, T5 (iOS), T6 (group), T7 (live). Flip workflow `on: push: branches: [main]`.
4. **Week 4** — Add T10 load, ship.sh gate, Slack alerts, coverage report bot.
5. **Day 30** — Review: FP rate, mean detection time, scenarios added from real incidents. Iterate.

---

## 11. Non-Goals (for now)

- No real iPhone device testing — Mac 207 simulators only. (Real-device farm = Phase 2.)
- No load past 1000 invites/60 s — T10 is smoke load, not the perf suite.
- No upgrade-in-place testing (install new APK over old, preserve user data). Add later.
- No paid-plan / IAP flows.

---

**Key insight from tonight's incident:** the envelope bug existed in C++ WS for 3 days because the only test was "do humans notice broken messages?" T1 of this harness would have caught it on the very first commit that introduced the regression, in 45 seconds, with a `failure_class=ENVELOPE_NOT_UNWRAPPED` dump pointing straight at `/opt/chatyy-ws-cpp/src/envelope.cpp`.
