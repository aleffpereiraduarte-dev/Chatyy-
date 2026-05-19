#!/usr/bin/env python3
"""
Wave D — chat.php patcher.

Adds the `ws_call_event` action so the Go WS server can POST server-issued
call lifecycle events (missed, cancel) and have PHP fan out the appropriate
silent push notifications (VoIP cancel, FCM data-only cancel, visible
missed-call push).

Run:
   python3 apply_chat_php.py /var/www/mail/api/chat.php
Then:
   docker restart chatyy-php-fpm
"""

import sys, os, re, shutil, time

PATCH_MARKER = "// [Wave D 2026-05-18 ws_call_event]"

PATCH_BODY = r"""
        // ============================================================
        // [Wave D 2026-05-18 ws_call_event] Server-issued call events.
        //
        // The Go WS server (chatyy-ws-go) POSTs here when it detects a
        // RINGING call that timed out (missed) or a caller who hung up
        // before the callee picked up (cancel). PHP's job:
        //   - missed → flip chat_call_history to status='missed' AND
        //     fire the visible missed-call push to the callee.
        //   - cancel → flip chat_call_history to status='ended' (no ring)
        //     AND fire a SILENT VoIP+FCM cancel push to every device the
        //     callee owns so CallKit / IncomingCallActivity dismiss.
        //
        // Auth: shared MAIL_WS_KEY via X-WS-Internal header — same secret
        // the Go server uses for verifyChatMembership.
        // ============================================================
        case 'chat_ws_call_event': {
            // Internal-only — bail unless the WS server presented the shared key.
            $wsInternalKey = $_SERVER['HTTP_X_WS_INTERNAL'] ?? '';
            $expected = getenv('MAIL_WS_KEY') ?: '';
            if ($expected === '' && file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strncmp($line, '#', 1) === 0) continue;
                    [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
                    if (trim($k) === 'MAIL_WS_KEY') { $expected = trim($v); break; }
                }
            }
            if ($expected === '' || !hash_equals($expected, (string)$wsInternalKey)) {
                jsonResponse(false, null, 'unauthorized', 401);
            }
            $event = trim((string)($input['event'] ?? ''));
            $callId = trim((string)($input['call_id'] ?? ''));
            $callerEmail = strtolower(trim((string)($input['caller_email'] ?? '')));
            $calleeEmail = strtolower(trim((string)($input['callee_email'] ?? '')));
            if ($callId === '' || !in_array($event, ['missed', 'cancel'], true)) {
                jsonResponse(false, null, 'event + call_id required', 400);
            }

            // Resolve conversation_id from the call_card for the missed-call push
            // body. We look at any chat_call_history row referencing this call_id —
            // both the caller's outgoing row and the callee's incoming row carry
            // the same conversation_id.
            $conversationId = 0;
            try {
                $r = $db->prepare("SELECT conversation_id FROM chat_call_history WHERE call_id = :c LIMIT 1");
                $r->execute([':c' => $callId]);
                $conversationId = (int)($r->fetchColumn() ?: 0);
            } catch (Throwable $_) {}

            // Update chat_call_history rows — every participant's row gets the
            // new terminal status so the Calls tab reflects reality immediately.
            try {
                $newStatus = $event === 'missed' ? 'missed' : 'ended';
                $db->prepare("UPDATE chat_call_history SET status = :s WHERE call_id = :c AND status IN ('ringing','calling')")
                   ->execute([':s' => $newStatus, ':c' => $callId]);
            } catch (Throwable $e) { error_log('[ws_call_event.history] ' . $e->getMessage()); }

            // Also flip the in-thread call_card so the bubble status updates
            // for every member of the conversation (the WS chat_message edit
            // broadcast paints the new status on every open thread).
            try {
                $rows = $db->prepare("SELECT id, conversation_id, content FROM chat_messages WHERE type = 'call_card' AND content LIKE :p ORDER BY id DESC LIMIT 1");
                $rows->execute([':p' => '%"' . $callId . '"%']);
                $row = $rows->fetch();
                if ($row) {
                    $j = json_decode($row['content'], true) ?: [];
                    $j['status'] = $event === 'missed' ? 'missed' : 'ended';
                    $db->prepare("UPDATE chat_messages SET content = :c WHERE id = :id")
                       ->execute([':c' => json_encode($j, JSON_UNESCAPED_UNICODE), ':id' => $row['id']]);
                    try { broadcastChatMessage($db, (int)$row['conversation_id'], (int)$row['id'], $callerEmail ?: 'system', 'edit'); } catch (Throwable $_) {}
                }
            } catch (Throwable $_) {}

            // Resolve caller display info — used by both the missed-call push
            // body and the cancel push payload (so iOS CallKit knows whose
            // call is being dismissed).
            $callerName = '';
            if ($callerEmail !== '') {
                try { $callerName = chatDisplayName($callerEmail) ?: $callerEmail; }
                catch (Throwable $_) { $callerName = $callerEmail; }
            }

            if ($event === 'missed') {
                // Visible missed-call push — exactly like the client-side
                // call_status 'missed' branch but server-issued. Only fires
                // to the CALLEE (the caller already sees the "Calling…"
                // overlay tear down via the WS call_missed broadcast).
                if ($calleeEmail !== '' && $callerEmail !== '' && $conversationId > 0) {
                    try {
                        if (!function_exists('fcmSendToUser')) {
                            require_once __DIR__ . '/firebase_push.php';
                        }
                        $missData = [
                            'type'            => 'missed_call',
                            'category_id'     => 'missed_call',
                            'conversation_id' => (string)$conversationId,
                            'caller_email'    => $callerEmail,
                            'caller_name'     => $callerName,
                            'call_id'         => $callId,
                            'group_key'       => 'missed_call_' . $conversationId,
                            'thread_id'       => 'chat_' . $conversationId,
                        ];
                        fcmSendToUser($calleeEmail, 'Chamada perdida', $callerName, $missData);
                    } catch (Throwable $e) {
                        error_log('[ws_call_event.missed_push] ' . $e->getMessage());
                    }
                }
            } else { // cancel
                // Silent fanout: every device the callee owns must dismiss
                // its incoming-call UI (CallKit + IncomingCallActivity). WS
                // handled the online sessions already; we cover the offline /
                // background ones via:
                //   - APNs VoIP push with type=call_cancel (CallKit reads the
                //     payload and reports .endedReason: .remoteEnded);
                //   - FCM data-only push with type=call_cancel (Android
                //     CallFirebaseMessagingService closes IncomingCallActivity).
                if ($calleeEmail !== '') {
                    $cancelData = [
                        'type'         => 'call_cancel',
                        'category_id'  => 'incoming_call',
                        'call_id'      => $callId,
                        'caller_email' => $callerEmail,
                        'caller_name'  => $callerName,
                        'reason'       => 'caller_hangup',
                    ];
                    try {
                        if (!function_exists('sendVoipPushToUser')) {
                            @require_once __DIR__ . '/voip_push.php';
                        }
                        if (function_exists('sendVoipPushToUser')) {
                            @sendVoipPushToUser($calleeEmail, $cancelData);
                        }
                    } catch (Throwable $e) {
                        error_log('[ws_call_event.cancel_voip] ' . $e->getMessage());
                    }
                    try {
                        if (!function_exists('fcmSendToUser')) {
                            require_once __DIR__ . '/firebase_push.php';
                        }
                        // No visible title/body — data-only via group_key
                        // suppression on the receiving side. fcmSendToUser
                        // upgrades incoming_call/call_cancel to data-only on
                        // Android automatically (isCall branch in firebase_push.php).
                        $cancelData['type'] = 'call_cancel';
                        $cancelData['silent'] = '1';
                        fcmSendToUser($calleeEmail, '', '', $cancelData);
                    } catch (Throwable $e) {
                        error_log('[ws_call_event.cancel_fcm] ' . $e->getMessage());
                    }
                }
            }

            jsonResponse(true, [
                'event'   => $event,
                'call_id' => $callId,
            ], 'ok');
            break;
        }

"""


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/var/www/mail/api/chat.php"
    if not os.path.exists(path):
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(2)

    src = open(path).read()
    if PATCH_MARKER in src:
        print("chat.php already patched — no-op.")
        return

    backup = f"{path}.bak-wave-d-{int(time.time())}"
    shutil.copy(path, backup)
    print(f"Backed up to {backup}")

    # Insert before the call_notify case (clean anchor).
    anchor = "        // ============================================================\n        // call_notify — Create call_card message when a call starts\n        // ============================================================\n        case 'call_notify': {"
    if anchor not in src:
        print("ERROR: call_notify anchor not found", file=sys.stderr)
        sys.exit(3)
    src = src.replace(anchor, PATCH_BODY + anchor, 1)

    open(path, "w").write(src)
    print(f"Patched {path} (added ws_call_event action)")
    print("Now: docker restart chatyy-php-fpm")


if __name__ == "__main__":
    main()
