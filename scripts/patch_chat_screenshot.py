#!/usr/bin/env python3
"""One-shot patch: insert chat_screenshot_event handler into chat.php.

Idempotent — bails out if the case is already present. Run on the
production server against /var/www/mail/api/chat.php.
"""
import sys

PATH = '/var/www/mail/api/chat.php'
with open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()

if "case 'chat_screenshot_event'" in src:
    print('Already patched.', file=sys.stderr)
    sys.exit(0)

ANCHOR = """        case 'chat_backup_list':
        case 'chat_discover_channels':
        case 'chat_message_history': {
            requireChatAuth();
            jsonResponse(true, ['items' => [], 'list' => [], 'backups' => []]);
            break;
        }
"""

INSERT = ANCHOR + """
        // chat_screenshot_event — peer (the *recipient*) just took a
        // screenshot inside ChatMediaViewer. Insert a system msg with
        // content='screenshot_event' so both sides see the timeline
        // bubble (privacy moat — Snapchat/Telegram secret-chat parity),
        // then broadcast chat_message via the WS bridge so all connected
        // devices render it in real time. Best-effort: insert + WS failures
        // must NOT surface — the local watermark UX is still active.
        case 'chat_screenshot_event': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $messageId      = (int)($input['message_id']      ?? 0);
            if ($conversationId <= 0) jsonResponse(false, null, 'conversation_id required', 400);
            try { requireConversationMember($db, $conversationId, $user['email']); }
            catch (\\Throwable $e) { jsonResponse(false, null, 'Not a member', 403); }

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
            } catch (\\Throwable $e) { jsonResponse(false, null, 'PG unavailable', 503); }

            $nowIso = gmdate('Y-m-d\\TH:i:s\\Z');
            $insertedId = 0;
            $createdAt = $nowIso;
            try {
                $st = $pg->prepare(\"
                    INSERT INTO chat_messages
                        (conversation_id, sender_email, sender_name, content, type, reply_to_id, created_at)
                    VALUES
                        (:cid, :se, :sn, 'screenshot_event', 'system', :ref, :ts)
                    RETURNING id, created_at
                \");
                $st->execute([
                    ':cid' => $conversationId,
                    ':se'  => $user['email'],
                    ':sn'  => chatDisplayName($user['email']),
                    ':ref' => $messageId > 0 ? $messageId : null,
                    ':ts'  => $nowIso,
                ]);
                $row = $st->fetch(\\PDO::FETCH_ASSOC);
                $insertedId = (int)($row['id'] ?? 0);
                $createdAt  = (string)($row['created_at'] ?? $nowIso);
            } catch (\\Throwable $e) { error_log('[chat_screenshot_event.insert] ' . $e->getMessage()); }

            try {
                $wsKey = getenv('CHAT_WS_API_KEY') ?: '';
                if ($wsKey === '') { @include_once __DIR__ . '/env.php'; $wsKey = getenv('CHAT_WS_API_KEY') ?: ''; }
                if ($wsKey) {
                    $peersStmt = $db->prepare(\"SELECT email FROM chat_conversation_members WHERE conversation_id = :cid\");
                    $peersStmt->execute([':cid' => $conversationId]);
                    $allEmails = array_column($peersStmt->fetchAll(\\PDO::FETCH_ASSOC), 'email');
                    $payloadMsg = [
                        'id'              => $insertedId,
                        'conversation_id' => $conversationId,
                        'sender_email'    => $user['email'],
                        'sender_name'     => chatDisplayName($user['email']),
                        'content'         => 'screenshot_event',
                        'type'            => 'system',
                        'subtype'         => 'screenshot',
                        'reply_to_id'     => $messageId > 0 ? $messageId : null,
                        'created_at'      => $createdAt,
                    ];
                    $channels = [\"chat_{$conversationId}\"];
                    foreach ($allEmails as $em) $channels[] = \"chat_user_\" . strtolower($em);
                    $payloadBase = json_encode(['channel' => null, 'event' => 'chat_message', 'data' => $payloadMsg]);
                    foreach ($channels as $ch) {
                        $body = preg_replace('/\"channel\":null/', '\"channel\":' . json_encode($ch), $payloadBase, 1);
                        $cu = curl_init('http://127.0.0.1:8081/broadcast');
                        curl_setopt_array($cu, [
                            CURLOPT_POST => true,
                            CURLOPT_POSTFIELDS => $body,
                            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                            CURLOPT_RETURNTRANSFER => true,
                            CURLOPT_TIMEOUT_MS => 1500,
                            CURLOPT_CONNECTTIMEOUT_MS => 500,
                        ]);
                        @curl_exec($cu); @curl_close($cu);
                    }
                }
            } catch (\\Throwable $e) { error_log('[chat_screenshot_event.ws] ' . $e->getMessage()); }

            jsonResponse(true, ['id' => $insertedId, 'created_at' => $createdAt]);
            break;
        }
"""

if ANCHOR not in src:
    print('Anchor not found.', file=sys.stderr)
    sys.exit(1)

new_src = src.replace(ANCHOR, INSERT, 1)
with open(PATH, 'w', encoding='utf-8') as f:
    f.write(new_src)
print('Patched chat.php with chat_screenshot_event handler.')
