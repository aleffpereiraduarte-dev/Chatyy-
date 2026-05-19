#!/usr/bin/env python3
"""
Wave D — Go WS server (main.go) patcher.

Idempotent: re-running is a no-op once patches are in place.

Adds:
1. CallRingTimeout constant (30s).
2. Per-call goroutine in handleCallInvite that, if the call is still RINGING
   after CallRingTimeout, broadcasts call_missed to the caller's sessions
   and pings PHP to fire a missed-call push to the callee.
3. handleCallEnd: when the CALLER ends during RINGING (caller cancelled
   before the callee picked up), also broadcast `call_cancel` to the
   callee's sessions and ask PHP to fire a silent VoIP+FCM cancel push.

Run with sudo:
   python3 apply_main_go.py /opt/chatyy-ws-go/main.go
Then:
   cd /opt/chatyy-ws-go && go build -o chatyy-ws-go . && systemctl restart chatyy-ws-go
"""

import sys, os, re, shutil, time

PATCH_MARKER = "// [Wave D 2026-05-18]"

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/opt/chatyy-ws-go/main.go"
    if not os.path.exists(path):
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(2)

    src = open(path).read()
    if PATCH_MARKER in src:
        print(f"main.go already has Wave D patches — no-op.")
        return

    backup = f"{path}.bak-wave-d-{int(time.time())}"
    shutil.copy(path, backup)
    print(f"Backed up to {backup}")

    # 1) Add CallRingTimeout constant next to CallStateExpiry
    needle = "\tCallStateExpiry        = 5 * time.Minute\n"
    if needle not in src:
        print("ERROR: anchor for CallStateExpiry not found", file=sys.stderr); sys.exit(3)
    addition = (
        "\tCallStateExpiry        = 5 * time.Minute\n"
        "\t// CallRingTimeout — WhatsApp parity. If a RINGING call isn't ACCEPTED\n"
        "\t// within this window we auto-mark it missed: broadcast call_missed to\n"
        "\t// the caller + ping PHP to fire the missed-call push to the callee.\n"
        "\t" + PATCH_MARKER + "\n"
        "\tCallRingTimeout        = 30 * time.Second\n"
    )
    src = src.replace(needle, addition, 1)

    # 2) Add notifyBackendCallEvent helper just before func (h *Hub) handleCallInvite
    helper_anchor = "func (h *Hub) handleCallInvite(c *Client, msg map[string]interface{}) {"
    if helper_anchor not in src:
        print("ERROR: handleCallInvite anchor not found", file=sys.stderr); sys.exit(4)
    helper_code = """// notifyBackendCallEvent — async POST to PHP /api/chat.php so it can fire
// push notifications for server-issued call events (missed, cancel). The
// PHP side handles VoIP/FCM fanout to every callee device. We use the
// X-WS-Internal header (same secret apiKey used everywhere else) for auth.
// """ + PATCH_MARKER + """
func (h *Hub) notifyBackendCallEvent(eventType, callID, callerEmail, calleeEmail string) {
\tif eventType == "" || callID == "" {
\t\treturn
\t}
\tgo func() {
\t\tbody, _ := json.Marshal(map[string]string{
\t\t\t"action":        "ws_call_event",
\t\t\t"event":         eventType,
\t\t\t"call_id":       callID,
\t\t\t"caller_email":  callerEmail,
\t\t\t"callee_email":  calleeEmail,
\t\t})
\t\treq, err := http.NewRequest("POST",
\t\t\t"https://chatyy.com.br/api/chat.php?action=ws_call_event",
\t\t\tstrings.NewReader(string(body)))
\t\tif err != nil {
\t\t\treturn
\t\t}
\t\treq.Header.Set("Content-Type", "application/json")
\t\treq.Header.Set("X-WS-Internal", apiKey)
\t\tclient := &http.Client{Timeout: 5 * time.Second}
\t\tresp, err := client.Do(req)
\t\tif err != nil {
\t\t\tlog.Printf("[CallEvent] %s [%s] POST failed: %v", eventType, callID, err)
\t\t\treturn
\t\t}
\t\tdefer resp.Body.Close()
\t\tif resp.StatusCode != 200 {
\t\t\tlog.Printf("[CallEvent] %s [%s] PHP returned %d", eventType, callID, resp.StatusCode)
\t\t}
\t}()
}

""" + helper_anchor
    src = src.replace(helper_anchor, helper_code, 1)

    # 3) Patch handleCallInvite — append the 30s timeout goroutine right
    # before the closing brace of the function.
    # We anchor by the existing trailing log line + closing brace.
    invite_anchor_old = (
        "\tdelivered := h.broadcastToEmail(targetEmail, invitePayload, \"\")\n"
        "\tlog.Printf(\"[Call] call_invite %s -> %s [%s]: %s\", c.email, targetEmail,\n"
        "\t\tcallID, map[bool]string{true: \"delivered\", false: \"offline\"}[delivered > 0])\n"
        "}\n"
    )
    if invite_anchor_old not in src:
        print("ERROR: handleCallInvite tail anchor not found", file=sys.stderr); sys.exit(5)
    invite_anchor_new = (
        "\tdelivered := h.broadcastToEmail(targetEmail, invitePayload, \"\")\n"
        "\tlog.Printf(\"[Call] call_invite %s -> %s [%s]: %s\", c.email, targetEmail,\n"
        "\t\tcallID, map[bool]string{true: \"delivered\", false: \"offline\"}[delivered > 0])\n"
        "\n"
        "\t// " + PATCH_MARKER + " 30s missed-call timeout. If the callee never\n"
        "\t// transitions to ACCEPTED (busy, declined-by-system, offline the whole\n"
        "\t// window), broadcast call_missed to the caller's sessions so the\n"
        "\t// /call \"Calling…\" overlay tears down + history row flips to missed,\n"
        "\t// and ask PHP to deliver the missed-call push to the callee.\n"
        "\tcallerEmail := c.email\n"
        "\ttargetCopy := targetEmail\n"
        "\tcallIDCopy := callID\n"
        "\tgo func() {\n"
        "\t\ttime.Sleep(CallRingTimeout)\n"
        "\t\tcsNow := h.getCallState(callIDCopy)\n"
        "\t\tif csNow == nil || csNow.State != \"RINGING\" {\n"
        "\t\t\treturn\n"
        "\t\t}\n"
        "\t\th.setCallState(callIDCopy, \"MISSED\", \"\", \"\")\n"
        "\t\tlog.Printf(\"[Call] call_missed (auto-timeout) %s -> %s [%s]\", callerEmail, targetCopy, callIDCopy)\n"
        "\t\th.broadcastToEmail(callerEmail, map[string]interface{}{\n"
        "\t\t\t\"type\":    \"call_missed\",\n"
        "\t\t\t\"call_id\": callIDCopy,\n"
        "\t\t\t\"reason\":  \"timeout\",\n"
        "\t\t}, \"\")\n"
        "\t\t// Also send to callee's WS sessions so any ringing UI cleans up\n"
        "\t\t// even when the device IS online but the user just walked away.\n"
        "\t\th.broadcastToEmail(targetCopy, map[string]interface{}{\n"
        "\t\t\t\"type\":    \"call_missed\",\n"
        "\t\t\t\"call_id\": callIDCopy,\n"
        "\t\t\t\"reason\":  \"timeout\",\n"
        "\t\t}, \"\")\n"
        "\t\th.notifyBackendCallEvent(\"missed\", callIDCopy, callerEmail, targetCopy)\n"
        "\t}()\n"
        "}\n"
    )
    src = src.replace(invite_anchor_old, invite_anchor_new, 1)

    # 4) Patch handleCallEnd — when caller ends during RINGING, also send
    # call_cancel to the callee's sessions + ping PHP for silent cancel push.
    # We anchor on the final block of handleCallEnd:
    end_anchor_old = (
        "\th.setCallState(callID, \"ENDED\", \"\", \"\")\n"
        "\tlog.Printf(\"[Call] call_end %s -> %s [%s]: %s\", c.email, targetEmail, callID, reason)\n"
        "\th.broadcastToEmail(targetEmail, map[string]interface{}{\n"
        "\t\t\"type\":    \"call_end\",\n"
        "\t\t\"call_id\": callID,\n"
        "\t\t\"reason\":  reason,\n"
        "\t}, \"\")\n"
        "\th.mu.Lock()\n"
        "\tdelete(h.pendingOffers, strings.ToLower(targetEmail))\n"
        "\th.mu.Unlock()\n"
        "}\n"
    )
    if end_anchor_old not in src:
        print("ERROR: handleCallEnd tail anchor not found", file=sys.stderr); sys.exit(6)
    end_anchor_new = (
        "\t// " + PATCH_MARKER + " Caller hung up before the callee answered.\n"
        "\t// Emit a dedicated call_cancel event (in addition to call_end, kept\n"
        "\t// for older callee builds) and ping PHP so it can fire a SILENT\n"
        "\t// VoIP+FCM cancel push to every callee device — without this, an\n"
        "\t// iPhone that received the original VoIP push keeps showing the\n"
        "\t// CallKit fullscreen even though the caller already aborted.\n"
        "\twasRinging := cs != nil && cs.State == \"RINGING\" && strings.EqualFold(cs.Caller, c.email)\n"
        "\th.setCallState(callID, \"ENDED\", \"\", \"\")\n"
        "\tlog.Printf(\"[Call] call_end %s -> %s [%s]: %s\", c.email, targetEmail, callID, reason)\n"
        "\th.broadcastToEmail(targetEmail, map[string]interface{}{\n"
        "\t\t\"type\":    \"call_end\",\n"
        "\t\t\"call_id\": callID,\n"
        "\t\t\"reason\":  reason,\n"
        "\t}, \"\")\n"
        "\tif wasRinging {\n"
        "\t\th.broadcastToEmail(targetEmail, map[string]interface{}{\n"
        "\t\t\t\"type\":    \"call_cancel\",\n"
        "\t\t\t\"call_id\": callID,\n"
        "\t\t\t\"reason\":  reason,\n"
        "\t\t}, \"\")\n"
        "\t\th.notifyBackendCallEvent(\"cancel\", callID, c.email, targetEmail)\n"
        "\t}\n"
        "\th.mu.Lock()\n"
        "\tdelete(h.pendingOffers, strings.ToLower(targetEmail))\n"
        "\th.mu.Unlock()\n"
        "}\n"
    )
    src = src.replace(end_anchor_old, end_anchor_new, 1)

    open(path, "w").write(src)
    print(f"Patched {path} (4 sections)")
    print("Now: cd /opt/chatyy-ws-go && go build -o chatyy-ws-go . && systemctl restart chatyy-ws-go")

if __name__ == "__main__":
    main()
