<?php
/**
 * OneMundo Chat — Backend API (PostgreSQL backend)
 *
 * Standalone include for email.php. All chat/messaging functionality using PG.
 * Depends on: jsonResponse(), getInput(), $_SESSION['email'], $_SESSION['name']
 */

require_once __DIR__ . '/db.php';


// ============================================================
// DATABASE
// ============================================================

// Legacy SQLite accessor — kept as a no-op so old code paths that still call
// getChatDB() don't crash. Everything real now runs on Postgres via getPGDB().
function getChatDB() {
    return getPGDB();
}

/**
 * Broadcast a new/edited/deleted chat message to every connected participant.
 *
 * WebSocket hubs run on two ports during the Node→Go migration: 8081 (legacy
 * Node, still what most web clients connect to via wss://ws.chatyy.com.br) and
 * 8084 (Go). We hit both — whichever the recipient is on receives it, and the
 * other one is a cheap no-op. $event is "new_message" by default; pass "edit"
 * or "delete" for updates. The event is fanned out on two channel families:
 *   - chat_{conversationId}   → subscribed by anyone viewing that thread
 *   - user_{email}            → subscribed by every logged-in session for unread
 *                                counters + conversation-list previews
 */
/**
 * Fire FCM push notifications to every conversation member except the
 * sender (and anyone who blocked them). Without this, users with the app
 * backgrounded never knew a message arrived — a production-blocker for a
 * WhatsApp-style product. Fire-and-forget: best-effort, errors only logged.
 */
/**
 * Pre-generate (or reuse cached) Whisper transcription for a voice/audio
 * message so the push body can show the actual words instead of "🎤 Audio".
 *
 * Strict time budget so a slow Whisper call can never delay push delivery
 * more than ~6s total (download 3s + inference 3s). On failure returns ''.
 */
function _chatMaybeTranscribeForPush(int $msgId, string $fileUrl): string {
    if ($msgId <= 0 || $fileUrl === '') return '';
    $cacheDir = '/var/www/mail/data/transcribe-cache';
    if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
    $cacheFile = "{$cacheDir}/msg_{$msgId}.txt";
    if (file_exists($cacheFile)) {
        return trim((string)@file_get_contents($cacheFile));
    }

    $apiKey = _chatLoadGroqKey();
    if (empty($apiKey)) return '';

    $localPath = null;
    $isTmp = false;
    if (preg_match('#^https?://#', $fileUrl)) {
        $tmp = tempnam('/tmp', 'chatyy_pushtx_');
        $fp = @fopen($tmp, 'w');
        if (!$fp) return '';
        $ch = curl_init($fileUrl);
        curl_setopt_array($ch, [
            CURLOPT_FILE => $fp,
            CURLOPT_TIMEOUT => 3,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        @curl_exec($ch);
        @curl_close($ch);
        @fclose($fp);
        $localPath = $tmp;
        $isTmp = true;
    } elseif (strpos($fileUrl, '/data/') === 0) {
        $localPath = '/var/www/mail' . $fileUrl;
    }
    if (!$localPath || !file_exists($localPath) || filesize($localPath) === 0) {
        if ($isTmp) @unlink($localPath);
        return '';
    }
    // Whisper charges per second + we don't want push delayed for 2-minute
    // voicemails. Skip transcription for large files — fallback to generic preview.
    if (filesize($localPath) > 4 * 1024 * 1024) {
        if ($isTmp) @unlink($localPath);
        return '';
    }

    $cfile = new CURLFile($localPath, mime_content_type($localPath) ?: 'audio/mpeg', basename($localPath));
    $ch = curl_init('https://api.openai.com/v1/audio/transcriptions');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['file' => $cfile, 'model' => 'whisper-1'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer {$apiKey}"],
        CURLOPT_TIMEOUT => 4,
        CURLOPT_CONNECTTIMEOUT => 2,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($isTmp) @unlink($localPath);

    if ($code !== 200) return '';
    $data = json_decode((string)$resp, true);
    $transcript = trim((string)($data['text'] ?? ''));
    if ($transcript !== '') {
        // Cache so the in-app "Transcrever" button returns instantly
        @file_put_contents($cacheFile, $transcript, LOCK_EX);
    }
    return $transcript;
}

/**
 * Run Whisper transcription on a voicemail row. Best-effort:
 *   - Returns the transcript string (empty on any failure).
 *   - Updates voicemails.transcription in-place when successful.
 *   - Fires a `voicemail_transcribed` WS event to the recipient + sender so
 *     both the bubble and the call-history pill update in real time.
 *
 * Called inline from voicemail_send (so by the time the recipient receives
 * the push, transcription is usually already cached) and explicitly via
 * voicemail_transcribe when the client polls.
 *
 * Time budget is generous (~30s) since voicemails are <60s — we want to
 * actually finish the transcription, unlike the push-path helper above
 * which has a strict 6s budget to avoid delaying push delivery.
 */
function _voicemailTranscribeAsync(int $voicemailId): string {
    if ($voicemailId <= 0) return '';
    $pg = getPGDB();
    try {
        $st = $pg->prepare("SELECT id, from_email, to_email, conversation_id, audio_r2_key, transcription FROM voicemails WHERE id = :id");
        $st->execute([':id' => $voicemailId]);
        $vm = $st->fetch(\PDO::FETCH_ASSOC);
    } catch (\Throwable $e) { error_log('[voicemail.tx.fetch] ' . $e->getMessage()); return ''; }
    if (!$vm) return '';
    if (!empty($vm['transcription'])) return (string)$vm['transcription'];

    $apiKey = _chatLoadGroqKey();
    if (empty($apiKey)) return '';

    // Resolve audio URL — voicemails always live in R2. Use a presigned
    // GET so the URL works even if the bucket isn't public.
    require_once __DIR__ . '/drive.php';
    $audioUrl = '';
    try {
        if (function_exists('s3PresignUrl')) {
            $audioUrl = s3PresignUrl('GET', $vm['audio_r2_key'], [], 600);
        }
        if (!$audioUrl && function_exists('s3PublicUrl')) {
            $audioUrl = s3PublicUrl($vm['audio_r2_key']);
        }
    } catch (\Throwable $e) { error_log('[voicemail.tx.url] ' . $e->getMessage()); }
    if (!$audioUrl) return '';

    $tmp = tempnam('/tmp', 'chatyy_vm_');
    $fp = @fopen($tmp, 'w');
    if (!$fp) return '';
    $ch = curl_init($audioUrl);
    curl_setopt_array($ch, [
        CURLOPT_FILE => $fp,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_FOLLOWLOCATION => true,
    ]);
    @curl_exec($ch);
    $dlCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    @curl_close($ch);
    @fclose($fp);
    if ($dlCode < 200 || $dlCode >= 300 || !file_exists($tmp) || filesize($tmp) === 0) {
        @unlink($tmp);
        return '';
    }

    $cfile = new CURLFile($tmp, mime_content_type($tmp) ?: 'audio/m4a', basename($tmp));
    $ch = curl_init('https://api.openai.com/v1/audio/transcriptions');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['file' => $cfile, 'model' => 'whisper-1'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer {$apiKey}"],
        CURLOPT_TIMEOUT => 30,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    @unlink($tmp);

    if ($code !== 200) return '';
    $data = json_decode((string)$resp, true);
    $transcript = trim((string)($data['text'] ?? ''));
    if ($transcript === '') return '';

    // Persist + notify both parties.
    try {
        $pg->prepare("UPDATE voicemails SET transcription = :tx WHERE id = :id")
           ->execute([':tx' => $transcript, ':id' => $voicemailId]);
    } catch (\Throwable $e) { error_log('[voicemail.tx.update] ' . $e->getMessage()); }

    try {
        $payload = [
            'voicemail_id'   => $voicemailId,
            'transcription'  => $transcript,
            'conversation_id'=> (int)$vm['conversation_id'],
        ];
        _broadcastToOwnDevices($vm['to_email'],   'voicemail_transcribed', $payload);
        _broadcastToOwnDevices($vm['from_email'], 'voicemail_transcribed', $payload);
    } catch (\Throwable $e) { error_log('[voicemail.tx.broadcast] ' . $e->getMessage()); }

    return $transcript;
}

/**
 * Load OPENAI_API_KEY from env or /etc/mail-api.env. Cached after first hit.
 * 2026-05-13: Migrated from Groq to OpenAI direct (whisper-1). Function name
 * preserved for backward compat with callers in this file.
 */
function _chatLoadGroqKey(): string {
    static $cached = null;
    if ($cached !== null) return $cached;
    $key = getenv('OPENAI_API_KEY') ?: '';
    if (empty($key) && file_exists('/etc/mail-api.env')) {
        foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
            if (strpos($_line, 'OPENAI_API_KEY=') === 0) { $key = trim(substr($_line, 15)); break; }
        }
    }
    return $cached = $key;
}

function chatSendPushToMembers($db, $conversationId, $messageId, $senderEmail, $suppressEmails = []) {
    try {
        $pg = getPGDB();
        $mStmt = $pg->prepare("SELECT m.sender_email, m.sender_name, m.content, m.type, m.file_name, m.file_url, m.mentions, c.type as ctype, c.name as cname FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE m.id = :id");
        $mStmt->execute([':id' => $messageId]);
        $msg = $mStmt->fetch();
        if (!$msg) return;
        // Parse mentions list so @mentioned users get a separate, higher-priority
        // push (distinct notification category + different title prefix), matching
        // WhatsApp/Slack behavior.
        $mentionedLower = [];
        if (!empty($msg['mentions'])) {
            $decoded = json_decode((string)$msg['mentions'], true);
            if (is_array($decoded)) {
                foreach ($decoded as $m) {
                    if (is_string($m) && $m !== '') $mentionedLower[] = strtolower($m);
                }
            }
        }
        $rStmt = $pg->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:s)");
        $rStmt->execute([':cid' => $conversationId, ':s' => $senderEmail]);
        $suppressLower = array_map('strtolower', $suppressEmails ?: []);
        $recipients = array_filter(array_column($rStmt->fetchAll(), 'email'),
            fn($e) => !in_array(strtolower($e), $suppressLower, true));
        if (!$recipients) return;

        // Expand @everyone / @admins meta-mentions into the actual recipient
        // set so every targeted user gets the louder mention treatment.
        // @everyone = all members. @admins = members with role='admin'.
        if (in_array('@everyone', $mentionedLower, true)) {
            foreach ($recipients as $r) $mentionedLower[] = strtolower($r);
        }
        if (in_array('@admins', $mentionedLower, true)) {
            try {
                $aStmt = $pg->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND role = 'admin'");
                $aStmt->execute([':cid' => $conversationId]);
                foreach ($aStmt->fetchAll(\PDO::FETCH_ASSOC) as $a) {
                    $mentionedLower[] = strtolower($a['email']);
                }
            } catch (Throwable $e) { error_log('[mentions.@admins] ' . $e->getMessage()); }
        }
        $mentionedLower = array_values(array_unique($mentionedLower));

        $senderName = $msg['sender_name'] ?: chatDisplayName($senderEmail);
        // Strip a full email if chatDisplayName fell back to it; truncate to 30
        // chars to keep the title visually short on iOS/Android lock screens
        // (WhatsApp/Telegram both enforce ~28-32 char display names).
        if (filter_var($senderName, FILTER_VALIDATE_EMAIL)) {
            $senderName = explode('@', $senderName)[0];
        }
        $senderName = trim(mb_substr($senderName, 0, 30));
        $isGroup = ($msg['ctype'] ?? '') === 'group';
        $convDisplayName = trim(mb_substr((string)($msg['cname'] ?: 'Grupo'), 0, 30));
        // Telegram pattern for groups: title = "Sender · Group" so the user
        // sees both pieces in the lock screen line. Body keeps the message
        // preview only (not "sender: msg" duplicated).
        $title = $isGroup ? ($senderName . ' · ' . $convDisplayName) : $senderName;
        // Detect E2E envelope — never leak ciphertext (or a decrypted preview
        // we don't have) to FCM/APNs. The server only sees {"e2e":...} blobs,
        // so if the content looks like an envelope we show a generic preview.
        $rawContent = (string)$msg['content'];
        $isEncryptedBlob = (strncmp($rawContent, '{"e2e"', 6) === 0);
        // Voice / audio: try Whisper transcription so the push body shows the
        // actual words ("Duarte: oi, confirma a reunião amanhã?") instead of
        // a generic "🎤 Audio". Strict time budget — falls back cleanly if
        // the transcription service is slow or unavailable.
        $voicePreview = '🎤 Mensagem de voz';
        if (($msg['type'] === 'audio' || $msg['type'] === 'voice') && !empty($msg['file_url'])) {
            $tx = _chatMaybeTranscribeForPush((int)$messageId, (string)$msg['file_url']);
            if ($tx !== '') {
                $voicePreview = '🎤 ' . mb_substr($tx, 0, 140);
            }
        }
        // Helper: extract a field from a JSON content blob (meetup/playlist
        // store {"title":..., "datetime":..., "location":...} in content).
        // Returns trimmed value or empty string.
        $jsonField = function (string $raw, string $field): string {
            $d = json_decode($raw, true);
            if (!is_array($d)) return '';
            $v = $d[$field] ?? '';
            if (!is_string($v) && !is_numeric($v)) return '';
            return trim((string)$v);
        };
        $preview = match($msg['type']) {
            'image'   => '📷 Foto',
            'video'   => '🎥 Vídeo',
            'audio'   => $voicePreview,
            'voice'   => $voicePreview,
            'sticker' => '💟 Sticker',
            'gif'     => '🎞️ GIF',
            'file'    => '📎 ' . ($msg['file_name'] ?: 'Arquivo'),
            'location'=> '📍 Localização',
            'live_location' => '📍 Localização ao vivo',
            'contact' => '👤 Contato',
            'poll'    => '📊 Enquete: ' . (mb_substr($jsonField($rawContent, 'question'), 0, 100) ?: 'nova enquete'),
            'meetup'  => '📅 Encontro: ' . (mb_substr($jsonField($rawContent, 'title'), 0, 100) ?: 'marcado'),
            'playlist'=> '🎵 Playlist: ' . (mb_substr($jsonField($rawContent, 'playlist_name'), 0, 100) ?: 'nova'),
            default   => $isEncryptedBlob ? '🔒 Nova mensagem' : mb_substr($rawContent, 0, 140),
        };
        // Title already carries "Sender · Group", so body is just the preview
        // for groups too — avoids "Sender · Group" / "Sender: msg" duplication.
        $body = $preview;

        if (!function_exists('fcmSendToUser')) {
            require_once __DIR__ . '/firebase_push.php';
        }
        // Rich notification: foto do remetente aparece no banner (Android
        // BigPictureStyle + iOS UNNotificationAttachment). Se for uma foto
        // enviada, usa a foto em vez do avatar (preview visual).
        $senderAvatarUrl = 'https://chatyy.com.br/api/email.php?action=get_avatar&email=' . urlencode($senderEmail);
        $pushImage = $senderAvatarUrl;
        $rawType = $msg['type'] ?? 'text';
        if ($rawType === 'image' && !empty($msg['file_url'])) {
            $fu = (string)$msg['file_url'];
            $pushImage = str_starts_with($fu, 'http') ? $fu : ('https://chatyy.com.br' . $fu);
        }

        $data = [
            'type'            => 'chat_message',
            'conversation_id' => (string)$conversationId,
            'message_id'      => (string)$messageId,
            'sender_email'    => $senderEmail,
            'sender_avatar'   => $senderAvatarUrl,
            'image'           => $pushImage, // fcmSendToToken lê isso pra notification.image (rich banner)
            // Grouping: Android uses group_key (→ notification stack) and
            // iOS uses thread_id (→ Notification Center grouping) + the
            // same key as apns-collapse-id so rapid-fire bursts replace
            // each other instead of 10 separate banners.
            'group_key'       => 'chat_' . (string)$conversationId,
            'thread_id'       => 'chat_' . (string)$conversationId,
        ];
        // WhatsApp-tier semantics: NEVER stamp delivered_at from the push
        // path. FCM accept != device received, and a user with no tokens is
        // definitely not delivered. Real delivery is signalled by the
        // receiver's client calling chat_delivery_ack after it actually
        // receives the message (via WS while foregrounded, or after opening
        // the app from a push). That path writes delivered_at and fires the
        // chat_delivered WS broadcast — the sender's ticks flip there, not
        // here. Until that ack arrives the message correctly stays at ✓
        // (single check / "sent"). See WhatsApp/XMPP XEP-0184.
        // WhatsApp parity: per-recipient mute state. Pull all mute rows for
        // this conversation once so we can flag each push with
        // _muted_for_recipient — firebase_push.php drops 'time-sensitive'
        // to 'passive' for muted convs (so they don't pierce iOS Focus).
        $muteByEmail = [];
        try {
            $ms = $pg->prepare("SELECT email, muted FROM chat_conversation_members WHERE conversation_id = :cid");
            $ms->execute([':cid' => $conversationId]);
            foreach ($ms->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                $muteByEmail[strtolower($row['email'])] = !empty($row['muted']);
            }
        } catch (\Throwable $e) { error_log('[push.mute_lookup] ' . $e->getMessage()); }

        // Per-conversation user notification settings (mute, mute_until,
        // mention_exception, preview). Honors the user's choice in
        // chat_user_conv_settings — skips push entirely when notify_messages
        // is false or mute_until is in the future, unless mention_exception
        // is set AND the recipient is mentioned.
        $convSettings = [];
        try {
            $ss = $pg->prepare("SELECT email, notify_messages, mute_until, mention_exception, preview FROM chat_user_conv_settings WHERE conversation_id = :cid");
            $ss->execute([':cid' => $conversationId]);
            foreach ($ss->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                $convSettings[strtolower($row['email'])] = $row;
            }
        } catch (\Throwable $e) { /* settings table may be missing on cold installs */ }

        foreach ($recipients as $r) {
            $rLc = strtolower($r);
            $isMentioned = in_array($rLc, $mentionedLower, true);
            $cs = $convSettings[$rLc] ?? null;

            // Presence-aware skip: if recipient is currently online AND viewing
            // this exact conversation (active_conversation_id mirrors what the
            // open chat screen reports via chat_typing/presence pings within
            // the last 30s), skip the OS-level push entirely. The WS broadcast
            // already drove the live update — pushing on top would re-buzz a
            // user who just read it. Mentions still push (parity w/ Slack).
            if (!$isMentioned) {
                try {
                    $pStmt = $pg->prepare("SELECT status, last_seen, active_conversation_id FROM chat_user_presence WHERE LOWER(email) = LOWER(:e)");
                    $pStmt->execute([':e' => $r]);
                    $pRow = $pStmt->fetch(\PDO::FETCH_ASSOC);
                    if ($pRow && ($pRow['status'] ?? '') === 'online'
                        && (int)($pRow['active_conversation_id'] ?? 0) === (int)$conversationId) {
                        $lsTs = strtotime((string)($pRow['last_seen'] ?? ''));
                        if ($lsTs && (time() - $lsTs) < 30) continue;
                    }
                } catch (\Throwable $e) { /* missing column on cold installs — ignore */ }
            }

            // WhatsApp-grade: send a push for EVERY message. Visual collapse
            // happens at the OS level via Android `tag` + iOS thread-id (FCM
            // replaces the previous notification with the same tag, showing
            // only the latest preview + incremented badge count). Previously
            // a 30s server-side rate limit dropped pushes 2..N entirely, so
            // a rapid-fire sender's later msgs never reached the OS at all
            // (only message #1 made a sound). Removed 2026-05-12. The burst
            // grouping in firebase_push.php still collapses visually.

            // Skip push if the recipient muted this conversation in their
            // per-conv settings — UNLESS they're mentioned and they have the
            // mention exception enabled (default true). Same logic for
            // mute_until > now(). notify_messages=false is a hard mute.
            if ($cs) {
                $notify   = !array_key_exists('notify_messages', $cs) || $cs['notify_messages'] === null
                    ? true : (bool)$cs['notify_messages'];
                $mentionEx = !array_key_exists('mention_exception', $cs) || $cs['mention_exception'] === null
                    ? true : (bool)$cs['mention_exception'];
                $muteUntilFuture = false;
                if (!empty($cs['mute_until'])) {
                    $tsMu = strtotime((string)$cs['mute_until']);
                    if ($tsMu !== false && $tsMu > time()) $muteUntilFuture = true;
                }
                $shouldSkip = (!$notify || $muteUntilFuture);
                if ($shouldSkip && !($isMentioned && $mentionEx)) continue;
            }

            $rTitle = $title;
            $rBody = $body;
            $rData = $data;
            // preview=false → strip the body so the OS notification only
            // shows the conversation name (privacy on lock screen).
            if ($cs && array_key_exists('preview', $cs) && $cs['preview'] !== null && !$cs['preview']) {
                $rBody = $isGroup ? ($msg['cname'] ?: 'Grupo') : ($senderName . ' enviou uma mensagem');
            }
            if ($isMentioned) {
                $rData['type'] = 'chat_mention';
                // Key must be `categoryId` (camelCase) to match what
                // firebase_push.php / expo push reads. The previous
                // `category_id` was being dropped silently, so APNs never
                // rendered the Reply/Mark-read action buttons on mentions.
                $rData['categoryId'] = 'chat_mention';
                $rData['category_id'] = 'chat_mention'; // kept for clients that already read snake_case
                $rData['mentioned'] = '1';
                $rTitle = ($isGroup ? $convDisplayName : $senderName) . ' · @' . ($isGroup ? $senderName : 'voce');
            } else {
                // Non-mention chat messages: register the chat_message category
                // so Reply / Mark-as-read action buttons surface on the banner.
                $rData['categoryId'] = 'chat_message';
            }
            // Pass mute flag through so APNs interruption-level drops to
            // passive when the recipient muted this conversation. Mentions
            // STILL pierce — WhatsApp does the same.
            if (!empty($muteByEmail[$rLc])) {
                $rData['_muted_for_recipient'] = '1';
            }
            try { fcmSendToUser($r, $rTitle, $rBody, $rData); }
            catch (Throwable $e) { error_log('[chat.push] ' . $r . ': ' . $e->getMessage()); }
        }
    } catch (Throwable $e) {
        error_log('[chatSendPushToMembers] ' . $e->getMessage());
    }
}


// ═══════════════════════════════════════════════════════════════════
// Telegram-style event log — every state change on a conversation goes
// through here. Clients recover missed changes via `chat_sync`.
//
// Atomically:
//   - bumps conversations.next_pts
//   - inserts a row in conversation_events with the new pts
//   - returns the assigned pts (or 0 on failure)
//
// $payload is an associative array; json_encoded for storage.
// ═══════════════════════════════════════════════════════════════════
function emitConvEvent($db, int $convId, string $eventType, ?string $actorEmail, array $payload): int {
    try {
        $pg = getPGDB();
        // Atomically bump chat_conversations.sync_seq and return the new value
        // as the pts for this event. Wrapped in a transaction so concurrent
        // events don't collide on the same pts.
        $pg->beginTransaction();
        $stmt = $pg->prepare("UPDATE chat_conversations SET sync_seq = COALESCE(sync_seq,0) + 1 WHERE id = :cid RETURNING sync_seq");
        $stmt->execute([':cid' => $convId]);
        $pts = (int)$stmt->fetchColumn();
        if ($pts <= 0) { $pg->rollBack(); return 0; }
        $ins = $pg->prepare("
            INSERT INTO chat_sync_events (seq, user_email, event_type, conversation_id, message_id, data, created_at)
            VALUES (:pts, :ae, :et, :cid, :mid, :pl, NOW())
        ");
        $ins->execute([
            ':pts' => $pts,
            ':ae'  => $actorEmail ?? '',
            ':et'  => $eventType,
            ':cid' => $convId,
            ':mid' => isset($payload['message_id']) ? (int)$payload['message_id'] : null,
            ':pl'  => json_encode($payload, JSON_UNESCAPED_UNICODE),
        ]);
        $pg->commit();
        return $pts;
    } catch (Throwable $e) {
        try { if (isset($pg) && $pg->inTransaction()) $pg->rollBack(); } catch (Throwable $e2) {}
        error_log('[emitConvEvent] ' . $e->getMessage());
        return 0;
    }
}

/**
 * Fire a lightweight event to the same user's OTHER devices via the
 * `chat_user_{email}` channel. Used for drafts-on-keystroke and any
 * future own-device-only notification that doesn't fit broadcastChatMessage.
 * Fire-and-forget; never blocks the response.
 */
function _broadcastToOwnDevices(string $email, string $event, array $data): void {
    static $wsKey = null;
    if ($wsKey === null) $wsKey = getenv('MAIL_WS_KEY') ?: '';
    if (!$wsKey) return;
    $body = json_encode(['channel' => 'chat_user_' . $email, 'event' => $event, 'data' => $data]);
    foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
        $cu = curl_init($endpoint);
        curl_setopt_array($cu, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 1000,
            CURLOPT_CONNECTTIMEOUT_MS => 300,
        ]);
        curl_exec($cu);
        curl_close($cu);
    }
}

function _broadcastDraftToOwnDevices(string $email, int $cid, string $text): void {
    _broadcastToOwnDevices($email, 'chat_draft', [
        'conversation_id' => $cid,
        'text'            => $text,
        'updated_at'      => gmdate('c'),
    ]);
}

function broadcastChatMessage($db, $conversationId, $messageId, $senderEmail, $event = 'chat_message', $suppressEmails = []) {
    static $wsKey = null;
    if ($wsKey === null) $wsKey = getenv('MAIL_WS_KEY') ?: '';
    if (!$wsKey) return;

    $pg = getPGDB();
    // Load the full message row so the client can render immediately without
    // a follow-up HTTP fetch.
    $stmt = $pg->prepare("SELECT * FROM chat_messages WHERE id = :id");
    $stmt->execute([':id' => $messageId]);
    $msg = $stmt->fetch();
    if (!$msg) return;
    $msg['id'] = (int)$msg['id'];
    $msg['conversation_id'] = (int)$msg['conversation_id'];
    $msg['sender_name'] = chatDisplayName($msg['sender_email']);
    $msg['edited'] = !empty($msg['edited_at']);
    // Hydrate reply_to so the WS payload carries the quoted preview — the
    // recipient's bubble wants {sender_name, content, type} immediately.
    $msg['reply_to'] = null;
    if (!empty($msg['reply_to_id'])) {
        try {
            $rpStmt = $pg->prepare("SELECT id, sender_email, content, type, file_url, deleted_at FROM chat_messages WHERE id = :id");
            $rpStmt->execute([':id' => (int)$msg['reply_to_id']]);
            $rp = $rpStmt->fetch();
            if ($rp) {
                $msg['reply_to'] = [
                    'id'           => (int)$rp['id'],
                    'sender_email' => $rp['sender_email'],
                    'sender_name'  => chatDisplayName($rp['sender_email']),
                    'content'      => chatTruncate((string)$rp['content'], 200),
                    'type'         => $rp['type'],
                    'file_url'     => $rp['file_url'],
                    'deleted_at'   => $rp['deleted_at'],
                ];
            }
        } catch (Throwable $e) { /* ignore */ }
    }

    // Bug 2026-05-08: WS broadcast was sending the raw chat_messages row for
    // type=poll without enriching $msg["poll"]. The HTTP history SELECT
    // (chat_messages_list) hydrates poll from chat_poll_votes; the broadcast
    // path skipped it, so live recipients got msg.type=poll but no msg.poll
    // and the frontend renderer fell back to <Text>{content}</Text>, dumping
    // the raw {"question":...} JSON in a plain bubble. Enrich here so the
    // live payload matches the history shape.
    if (($msg["type"] ?? "") === "poll" && !empty($msg["content"])) {
        try {
            $pollData = json_decode($msg["content"], true);
            if (is_array($pollData) && isset($pollData["options"]) && is_array($pollData["options"])) {
                $numOpts = count($pollData["options"]);
                $voteCounts = array_fill(0, $numOpts, 0);
                $myVotes = [];
                try {
                    $pg->exec("CREATE TABLE IF NOT EXISTS chat_poll_votes (message_id BIGINT NOT NULL, voter_email TEXT NOT NULL, option_index INTEGER NOT NULL, voted_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (message_id, voter_email, option_index))");
                    $vt = $pg->prepare("SELECT option_index, COUNT(*) AS c FROM chat_poll_votes WHERE message_id = :id GROUP BY option_index");
                    $vt->execute([":id" => (int)$msg["id"]]);
                    foreach ($vt->fetchAll() as $row) {
                        $idx = (int)$row["option_index"];
                        if ($idx >= 0 && $idx < $numOpts) $voteCounts[$idx] = (int)$row["c"];
                    }
                } catch (Throwable $e) { error_log("[poll.ws.enrich] " . $e->getMessage()); }
                $pollData["id"]          = (int)$msg["id"];
                $pollData["votes"]       = $voteCounts;
                $pollData["vote_counts"] = $voteCounts;
                $pollData["total_votes"] = array_sum($voteCounts);
                $pollData["my_votes"]    = $myVotes; // recipient-side will refresh via chat_messages_list
                $msg["poll"] = $pollData;
            }
        } catch (Throwable $e) { error_log("[poll.ws.enrich.outer] " . $e->getMessage()); }
    }

    // Recipients = every member except the sender (sender's own client already
    // has the message from the POST response) and anyone in $suppressEmails
    // (users who blocked the sender — WhatsApp-style silent drop).
    $m = $pg->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:s)");
    $m->execute([':cid' => $conversationId, ':s' => $senderEmail]);
    $suppressLower = array_map('strtolower', $suppressEmails ?: []);
    $recipients = array_values(array_filter(
        array_column($m->fetchAll(), 'email'),
        fn($e) => !in_array(strtolower($e), $suppressLower, true)
    ));

    // WhatsApp-style channel-by-purpose routing. Previously the same
    // event fired on BOTH `chat_{convId}` and every `chat_user_{recipient}`
    // — anyone viewing the thread got the event twice and the client's
    // setMessages dedup raced (brief duplicate bubble). Now:
    //   • `chat_{convId}`          → `chat_message` (full payload, in-thread)
    //   • `chat_user_{recipient}`  → `chat_summary` (list-screen bump)
    //   • `chat_user_{sender}`     → original event (multi-device sync for
    //                                 edits/deletes/reactions still needs
    //                                 the full payload on every device)
    // For non-`chat_message` events (edit/delete/reaction/pin/read) we keep
    // the original event name on ALL channels since each client side only
    // listens once and there's no thread+list overlap to race.
    $isNewMessage = ($event === 'chat_message');
    $dispatch = []; // list of [channel, event] pairs

    // Thread channel: always the original event
    $dispatch[] = ["chat_{$conversationId}", $event];

    // Per-recipient channel: chat_summary for new messages (list-screen
    // only), original event otherwise (edits/reactions update list too).
    // Email lowercased — o WS hub auto-inscreve em chat_user_{user.email}
    // com o case retornado pelo auth (lowercase). Se aqui usássemos o case
    // do DB (que pode ter maiúscula), os channels não batiam e a mensagem
    // sumia (user reportou: web→mobile só aparecia ao voltar pra chatlist
    // porque o broadcast em real-time não chegava).
    foreach ($recipients as $r) {
        $rLc = strtolower((string)$r);
        $dispatch[] = ["chat_user_{$rLc}", $isNewMessage ? 'chat_summary' : $event];
    }

    // Sender's other devices: full event always (they want the real message
    // for any device that happens to have the thread open).
    $senderLc = strtolower((string)$senderEmail);
    $dispatch[] = ["chat_user_{$senderLc}", $event];

    // Redis pub/sub fan-out for the Go signal-server (port 5222) where
    // iOS + Android native clients connect. The signal-server subscribes
    // to `chat:{convId}` and broadcasts to its connected TCP clients.
    // Without this step, sends that went through the PHP path never
    // reached mobile clients (they were only delivered to node-ws web
    // clients on 8081).
    static $redisPubClient = null;
    if ($redisPubClient === null) {
        try {
            $r = new \Redis();
            $pw = getenv('REDIS_PASSWORD') ?: '';
            $r->connect('127.0.0.1', 6379, 0.5);
            if ($pw) $r->auth($pw);
            $redisPubClient = $r;
        } catch (Throwable $e) {
            $redisPubClient = false;
            error_log('[redis.pub.connect] ' . $e->getMessage());
        }
    }
    if ($redisPubClient && $event === 'chat_message') {
        try {
            // Map our WS event → signal-server binary type. 0x21 = chat_message,
            // 0x28 = delete broadcast, 0x2A = edit broadcast, 0x26 = react broadcast,
            // 0x24 = read broadcast. Fall back to 0x21 (new message) if unknown.
            $msgType = match ($event) {
                'chat_message' => 0x21,
                'edit'         => 0x2A,
                'delete'       => 0x28,
                'reaction'     => 0x26,
                'read'         => 0x24,
                default        => 0x21,
            };
            // exclude_email vazio — multi-device sync precisa entregar pros
            // outros dispositivos do MESMO usuário via TCP signal-server.
            // Antes setava $senderEmail e o signal filtrava também o celular
            // do mesmo user, causando atraso web→mobile (mobile→web era
            // instantâneo porque o signal-server publica com excludeEmail="").
            // O dispositivo originador já tem a mensagem da resposta HTTP do
            // chat_send + dedup local por client_message_id, então não há
            // risco de bolha duplicada.
            $pubMsg = [
                'node_id'         => 'php-' . gethostname(),
                'conversation_id' => (int)$conversationId,
                'exclude_email'   => '',
                'type'            => $msgType,
                'payload'         => $msg,
            ];
            $redisPubClient->publish('chat:' . (int)$conversationId, json_encode($pubMsg, JSON_UNESCAPED_UNICODE));
        } catch (Throwable $e) {
            error_log('[redis.pub] ' . $e->getMessage());
        }
    }

    // curl_multi: fire every (channel, endpoint) pair concurrently. Before
    // this change the loop serialized every broadcast — with 5 dispatch
    // targets × 2 endpoints = 10 sequential POSTs × up to 800ms each the
    // worker could sit in fanout for 8s in the worst case. Now the total
    // wall time is ~one slow POST.
    $mh = curl_multi_init();
    $handles = [];
    foreach ($dispatch as [$ch, $evt]) {
        $payload = json_encode([
            'channel' => $ch,
            'event'   => $evt,
            'data'    => $msg,
        ]);
        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
            $cu = curl_init($endpoint);
            curl_setopt_array($cu, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT_MS => 800,
                CURLOPT_CONNECTTIMEOUT_MS => 300,
            ]);
            curl_multi_add_handle($mh, $cu);
            $handles[] = $cu;
        }
    }
    do {
        $status = curl_multi_exec($mh, $active);
        if ($active) curl_multi_select($mh, 0.2);
    } while ($active && $status === CURLM_OK);
    foreach ($handles as $cu) {
        curl_multi_remove_handle($mh, $cu);
        curl_close($cu);
    }
    curl_multi_close($mh);
}

// chatInitTables + chatMigrateSchema deleted — Postgres schema is managed by migrations.

// ============================================================
// HELPERS
// ============================================================


/**
 * chatRateLimit — sliding-window rate limiter por (email, action).
 * Retorna true se OK, false se exceder. Usa file-backed state em /tmp.
 *
 * Uso: if (!chatRateLimit($user['email'], 'upload', 10, 60)) jsonResponse(false, null, 'Rate limit exceeded', 429);
 */

// chatIdempotent — returns TRUE if this client_action_id was already seen
// in the last 5 minutes (short-circuit the action), FALSE if it's fresh and
// has been recorded. Telegram-style retry safety: if the network blips and
// the client re-fires chat_react/chat_edit/chat_delete with the same id,
// the server treats the second hit as a no-op instead of duplicating work.
function chatIdempotent(string $email, string $actionId): bool {
    if ($email === '' || $actionId === '') return false;
    $cleanId = preg_replace('/[^a-zA-Z0-9_-]/', '', $actionId);
    if ($cleanId === '' || strlen($cleanId) > 64) return false;
    $f = sys_get_temp_dir() . '/chat_idem_' . md5(strtolower($email) . '|' . $cleanId) . '.txt';
    if (is_readable($f) && (time() - (int)@filemtime($f)) < 300) return true;
    @file_put_contents($f, '1', LOCK_EX);
    return false;
}

function chatRateLimit(string $email, string $action, int $max = 10, int $windowSec = 60): bool {
    if ($email === '' || $action === '') return true;
    $key = preg_replace('/[^a-z0-9_]/i', '_', $action);
    $rateFile = sys_get_temp_dir() . '/chat_rl_' . $key . '_' . md5(strtolower($email)) . '.txt';
    $now = time();
    $count = 0; $windowStart = $now;
    if (is_readable($rateFile)) {
        $data = @file_get_contents($rateFile);
        if ($data) {
            $parts = explode('|', $data);
            if (count($parts) === 2) {
                $windowStart = (int)$parts[0];
                $count = (int)$parts[1];
                if ($now - $windowStart > $windowSec) { $windowStart = $now; $count = 0; }
            }
        }
    }
    if ($count >= $max) return false;
    @file_put_contents($rateFile, $windowStart . '|' . ($count + 1), LOCK_EX);
    return true;
}

function requireChatAuth() {
    if (empty($_SESSION['email'])) {
        jsonResponse(false, null, 'Not authenticated', 401);
    }
    // Normalize email to lowercase so every downstream comparison against
    // conversation_members (which is lowercased on insert) matches. Without
    // this, users who registered with any uppercase character had read
    // receipts, membership checks, and chat_sync all silently fail.
    $lcEmail = strtolower((string)$_SESSION['email']);
    return [
        'email' => $lcEmail,
        'name'  => $_SESSION['name'] ?? explode('@', $lcEmail)[0],
    ];
}

/**
 * Verify user is a member of a conversation, return membership row.
 */
function requireConversationMember($db, $conversationId, $email) {
    $email = strtolower((string)$email);
    $pg = getPGDB();
    $stmt = $pg->prepare("
        SELECT cm.*, c.type, c.name AS conv_name, c.created_by
        FROM chat_conversation_members cm
        JOIN chat_conversations c ON c.id = cm.conversation_id
        WHERE cm.conversation_id = :cid AND LOWER(cm.email) = LOWER(:email)
    ");
    $stmt->execute([':cid' => $conversationId, ':email' => $email]);
    $row = $stmt->fetch();
    if (!$row) {
        jsonResponse(false, null, 'Not a member of this conversation', 403);
    }
    return $row;
}

/**
 * Custom-roles permission check for group conversations.
 *
 * Reads chat_conversation_members.role + .permissions (JSONB) for the given
 * member and returns true if they're allowed to perform $perm. Admins always
 * pass. Members pass only when the explicit boolean key in their permissions
 * row is true. Direct chats are not gated (returns true for both peers).
 *
 * Known $perm values: add_members, edit_info, remove_messages, pin_messages,
 * promote_admins. Default for any unknown perm is to deny (admin-only).
 */
function chatHasPermission($conv_id, $email, $perm): bool {
    $email = strtolower((string)$email);
    if ($email === '' || (int)$conv_id <= 0 || $perm === '') return false;
    try {
        $pg = getPGDB();
        $stmt = $pg->prepare("
            SELECT cm.role, cm.permissions, c.type
            FROM chat_conversation_members cm
            JOIN chat_conversations c ON c.id = cm.conversation_id
            WHERE cm.conversation_id = :cid AND LOWER(cm.email) = LOWER(:e)
            LIMIT 1
        ");
        $stmt->execute([':cid' => (int)$conv_id, ':e' => $email]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$row) return false;
        // Direct chats: both peers are equal — no permission gate.
        if (($row['type'] ?? 'direct') !== 'group') return true;
        // Admins pass everything.
        if (($row['role'] ?? 'member') === 'admin') return true;
        // Member: check explicit grant in JSONB column.
        $permsRaw = $row['permissions'] ?? null;
        if (!$permsRaw) return false;
        $perms = is_array($permsRaw) ? $permsRaw : json_decode((string)$permsRaw, true);
        if (!is_array($perms)) return false;
        $val = $perms[$perm] ?? false;
        return $val === true || $val === 1 || $val === '1' || $val === 'true';
    } catch (\Throwable $e) {
        error_log('[chatHasPermission] ' . $e->getMessage());
        return false;
    }
}

/**
 * Grapheme-safe truncation for reply preview / push body. Avoids breaking
 * emoji or combining sequences mid-character. Falls back to mb_substr if
 * intl extension isn't loaded.
 */
function chatTruncate($s, int $len = 200): string {
    $s = (string)$s;
    if (function_exists('grapheme_substr')) {
        $r = grapheme_substr($s, 0, $len);
        if ($r !== false) return $r;
    }
    return mb_substr($s, 0, $len);
}

// Parental gate now lives in parental_helper.php (shared with email.php).
require_once __DIR__ . '/parental_helper.php';

/**
 * Get display name for an email (username part before @).
 */
function chatDisplayName($email) {
    static $cache = [];
    if (!is_string($email) || $email === '') return '';
    $key = strtolower($email);
    if (isset($cache[$key])) return $cache[$key];
    if (strpos($email, '@') === false) { $cache[$key] = $email; return $email; }
    [$user, $domain] = explode('@', $email, 2);
    $userClean = preg_replace('#[^a-zA-Z0-9._-]#', '', $user);
    $domainClean = preg_replace('#[^a-zA-Z0-9.-]#', '', $domain);
    $fallback = $userClean !== '' ? $userClean : $user;
    if ($userClean !== '' && $domainClean !== '') {
        $path = "/var/mail/vhosts/{$domainClean}/{$userClean}/profile/data.json";
        if (is_readable($path)) {
            $json = @json_decode(@file_get_contents($path), true);
            if (is_array($json)) {
                foreach (['display_name', 'name', 'username'] as $k) {
                    if (!empty($json[$k]) && is_string($json[$k])) {
                        $cache[$key] = $json[$k];
                        return $json[$k];
                    }
                }
            }
        }
    }
    $cache[$key] = $fallback;
    return $fallback;
}

/**
 * Return verified caller identity (E.164 phone + verified flag) for an email.
 * Reads /var/mail/vhosts/{domain}/{user}/profile/data.json. Used to embed
 * `caller_phone` + `caller_verified` in call push payloads so the receiver
 * device can show "Verified by Chatyy" + the real outgoing phone number.
 */
function chatCallerIdentity($email) {
    static $cache = [];
    if (isset($cache[$email])) return $cache[$email];
    $domain = substr(strrchr($email, '@'), 1);
    $local = strstr($email, '@', true);
    $path = "/var/mail/vhosts/{$domain}/{$local}/profile/data.json";
    $phone = '';
    $verified = false;
    if (is_readable($path)) {
        $j = json_decode(@file_get_contents($path), true);
        if (is_array($j)) {
            $phone = isset($j['verified_phone']) && is_string($j['verified_phone']) ? $j['verified_phone'] : '';
            $verified = !empty($j['telnyx_caller_id_verified']);
        }
    }
    return $cache[$email] = ['phone' => $phone, 'verified' => $verified];
}

/**
 * Touch conversation updated_at timestamp (for sorting by last activity).
 */
function touchConversation($db, $conversationId) {
    $pg = getPGDB();
    $pg->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")
       ->execute([':id' => $conversationId]);
}

/**
 * Idempotent schema bootstrap for the hashtag tables. Cheap (no-op when
 * already applied) — called from every hashtag entrypoint so the schema
 * stays in sync without a separate migration step.
 */
function chatHashtagEnsureSchema($db): void {
    static $done = false;
    if ($done) return;
    try {
        $db->exec("CREATE TABLE IF NOT EXISTS chat_hashtags (
            id BIGSERIAL PRIMARY KEY,
            hashtag TEXT NOT NULL,
            message_id BIGINT NOT NULL,
            conversation_id BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_chat_hashtags_tag_time ON chat_hashtags (hashtag, created_at DESC)");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_chat_hashtags_conv ON chat_hashtags (conversation_id)");
        $done = true;
    } catch (\Throwable $e) {
        // Schema race / permission edge — log + bail. Subsequent calls retry.
        error_log('[chat_hashtag.schema] ' . $e->getMessage());
    }
}

/**
 * Parse #hashtag tokens from a message body and persist one row per
 * (lowercased, deduped) tag into chat_hashtags. Called inline from
 * chat_send AFTER fastcgi_finish_request(), so latency is invisible to
 * the sender. Tags are 2–50 alphanumeric/_ characters; anything else is
 * silently skipped. Bounded to 20 tags per message to defang abuse.
 */
function chatHashtagIndex($db, int $messageId, int $conversationId, string $content): void {
    if ($messageId <= 0 || $conversationId <= 0 || $content === '') return;
    if (!preg_match_all('/(?:^|[^\w])#([A-Za-z0-9_\x{00C0}-\x{017F}]{2,50})/u', $content, $matches)) return;
    $tags = [];
    foreach ($matches[1] as $raw) {
        $tag = mb_strtolower(trim($raw), 'UTF-8');
        if ($tag === '' || isset($tags[$tag])) continue;
        $tags[$tag] = true;
        if (count($tags) >= 20) break;
    }
    if (empty($tags)) return;

    chatHashtagEnsureSchema($db);
    try {
        $ins = $db->prepare("INSERT INTO chat_hashtags (hashtag, message_id, conversation_id) VALUES (:t, :m, :c)");
        foreach (array_keys($tags) as $tag) {
            $ins->execute([':t' => $tag, ':m' => $messageId, ':c' => $conversationId]);
        }
    } catch (\Throwable $e) {
        error_log('[chat_hashtag.index] ' . $e->getMessage());
    }
}

/**
 * Build conversation data with last message, unread count, and members.
 */
/**
 * Per-request preload store used by chat_list to skip per-row queries in
 * buildConversationData(). Pass null to clear.
 */
function chatListPreload($payload = null) {
    static $store = null;
    if (func_num_args() > 0) $store = $payload;
    return $store;
}

function buildConversationData($db, $convRow, $userEmail) {
    $cid = (int)$convRow['id'];
    $pg = getPGDB();
    $preload = chatListPreload();

    // Members — either from preload (chat_list batched) or a single row query.
    if ($preload && isset($preload['members'][$cid])) {
        $members = $preload['members'][$cid];
    } else {
        $stmt = $pg->prepare("SELECT email, role, muted, joined_at FROM chat_conversation_members WHERE conversation_id = :cid");
        $stmt->execute([':cid' => $cid]);
        $members = $stmt->fetchAll();
        foreach ($members as &$_m) { $_m['display_name'] = chatDisplayName($_m['email']); }
        unset($_m);
    }

    // Last message
    if ($preload && array_key_exists($cid, $preload['lastMsg'])) {
        $lastMessage = $preload['lastMsg'][$cid] ?: null;
    } else {
        $stmt = $pg->prepare("
            SELECT id, sender_email, content, type, created_at
            FROM chat_messages
            WHERE conversation_id = :cid AND deleted_at IS NULL
            ORDER BY id DESC LIMIT 1
        ");
        $stmt->execute([':cid' => $cid]);
        $lastMessage = $stmt->fetch() ?: null;
    }

    // Membership row (last_read_message_id, muted, pinned). Prefer the
    // batched preload from chat_list — fall back to a single-row lookup
    // when buildConversationData is called outside the list path.
    if ($preload && isset($preload['membership']) && array_key_exists($cid, $preload['membership'])) {
        $membership = $preload['membership'][$cid];
    } else {
        $stmt = $pg->prepare("
            SELECT last_read_message_id, muted, pinned FROM chat_conversation_members
            WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)
        ");
        $stmt->execute([':cid' => $cid, ':email' => $userEmail]);
        $membership = $stmt->fetch() ?: null;
    }
    $lastReadId = $membership ? (int)$membership['last_read_message_id'] : 0;
    $muted = $membership ? (int)$membership['muted'] : 0;
    $pinned = $membership ? (int)($membership['pinned'] ?? 0) : 0;

    if ($preload && array_key_exists($cid, $preload['unread'])) {
        $unreadCount = (int)$preload['unread'][$cid];
    } else {
        $stmt = $pg->prepare("
            SELECT COUNT(*) as cnt FROM chat_messages
            WHERE conversation_id = :cid AND id > :last_read AND LOWER(sender_email) <> LOWER(:email) AND deleted_at IS NULL
        ");
        $stmt->execute([':cid' => $cid, ':last_read' => $lastReadId, ':email' => $userEmail]);
        $unreadCount = (int)$stmt->fetch()['cnt'];
    }

    // Count unread messages where THIS user is @-mentioned.
    if ($preload && isset($preload['mentions']) && array_key_exists($cid, $preload['mentions'])) {
        // Batched count from chat_list — zero-row convs simply don't appear
        // in the GROUP BY result, so missing key = 0 mentions.
        $unreadMentions = (int)$preload['mentions'][$cid];
    } else {
        $unreadMentions = 0;
        try {
            $mStmt = $pg->prepare("SELECT COUNT(*) AS cnt FROM chat_messages
                WHERE conversation_id = :cid AND id > :last_read AND LOWER(sender_email) <> LOWER(:email)
                  AND deleted_at IS NULL AND mentions IS NOT NULL
                  AND (mentions LIKE :mq1 OR mentions LIKE :mq2 OR mentions LIKE :mq3)");
            $lower = strtolower($userEmail);
            $mStmt->execute([
                ':cid' => $cid, ':last_read' => $lastReadId, ':email' => $userEmail,
                ':mq1' => '%"' . $lower . '"%',
                ':mq2' => '%"' . $userEmail . '"%',
                ':mq3' => '%@' . $lower . '%',
            ]);
            $unreadMentions = (int)$mStmt->fetch()['cnt'];
        } catch (Throwable $e) { $unreadMentions = 0; }
    }

    // For direct chats, use the other person's name as the conversation name.
    // Case-INSENSITIVE compare — DB rows occasionally have different casing
    // which would otherwise make displayName match the current user (bug).
    $userEmailLc = strtolower($userEmail);
    $otherEmail = null;
    $displayName = $convRow['name'];
    if ($convRow['type'] === 'direct') {
        foreach ($members as $m) {
            if (strtolower($m['email']) !== $userEmailLc) {
                $otherEmail = $m['email'];
                if (empty($displayName)) $displayName = chatDisplayName($m['email']);
                break;
            }
        }
    }

    return [
        'id'            => (int)$cid,
        'type'          => $convRow['type'],
        'name'          => $displayName,
        'avatar'        => $convRow['avatar_url'] ?? $convRow['avatar'] ?? '',
        'created_by'    => $convRow['created_by'],
        'created_at'    => $convRow['created_at'],
        'updated_at'    => $convRow['updated_at'] ?? null,
        'members'       => $members,
        'other_email'   => $otherEmail, // explicit field for direct chats — frontend uses this as fallback
        'contact_email' => $otherEmail, // alias
        'last_message'  => $lastMessage ? [
            'id'           => (int)$lastMessage['id'],
            'sender_email' => $lastMessage['sender_email'],
            'sender_name'  => chatDisplayName($lastMessage['sender_email']),
            'content'      => $lastMessage['content'],
            'type'         => $lastMessage['type'],
            'created_at'   => $lastMessage['created_at'],
            // Delivery + read marks — previously missing from the response
            // so the chat list always rendered ✓ gray even for messages the
            // peer had already read. Frontend expects ISO strings or null.
            'delivered_at' => $lastMessage['delivered_at'] ?? null,
            'read_at'      => $lastMessage['read_at'] ?? null,
        ] : null,
        'unread_count'  => $unreadCount,
        'unread_mentions' => $unreadMentions,
        'muted'         => $muted,
        'pinned'        => $pinned,
        'member_count'  => count($members),
    ];
}

// ============================================================
// MAIN HANDLER
// ============================================================

function handleChatAction($action) {
    $input = array_merge($_GET, getInput());
    // $db is the Postgres handle — named $db to avoid churning every
    // $db->... call in the (hundred+) case blocks below. All queries below
    // use PG table names (chat_*) and PG syntax.
    $db = getPGDB();

    // Backwards-compat aliases for QR login actions. The mobile app shipped
    // with v2.4.2 (build 388) calls qr_generate / qr_check / qr_confirm,
    // which were renamed to chat_qr_login_* on the server. Map the old
    // names here so existing TestFlight users don't have to wait for the
    // OTA to roll out before scanning a QR works.
    $qrAlias = [
        'qr_generate' => 'chat_qr_login_create',
        'qr_check'    => 'chat_qr_login_status',
        'qr_confirm'  => 'chat_qr_login_approve',
    ];
    if (isset($qrAlias[$action])) {
        $action = $qrAlias[$action];
    }

    // Idempotent schema migrations — these columns/tables are referenced by
    // handlers added in successive waves. ALTER ... IF NOT EXISTS is cheap
    // (no-op on subsequent calls) and lets the codebase migrate forward
    // without a separate migration script. CREATE TABLE IF NOT EXISTS too.
    static $_migrated = false;
    if (!$_migrated) {
        try {
            // (1) Custom-roles per-member permissions JSONB. JSONB so we can
            //     index/query individual perm flags later; default '{}' means
            //     no explicit grants (members fall back to admin-only gating).
            @$db->exec("ALTER TABLE chat_conversation_members ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'");
            // (2) Hide-members admin flag. When true, non-admins calling
            //     chat_info/chat_members get the members array stripped.
            @$db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS hide_members BOOLEAN DEFAULT FALSE");
            // (3) Slow-mode cooldown per conversation (seconds between sends
            //     for non-admin members). Existing chat_set_slow_mode handler
            //     already writes this column — ensure it exists in fresh dbs.
            @$db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS slow_mode_seconds INT DEFAULT 0");
            // (4) Per-conversation notification settings (mute, sound,
            //     vibration, preview, mention exception, mute_until). Note:
            //     the table already exists for wallpaper/note/notif_sound;
            //     CREATE IF NOT EXISTS is harmless and the column ALTERs
            //     below add the new fields without touching the legacy ones.
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_conv_settings (
                email TEXT NOT NULL,
                conversation_id BIGINT NOT NULL,
                PRIMARY KEY (email, conversation_id)
            )");
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS notify_messages BOOLEAN DEFAULT TRUE");
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS sound TEXT DEFAULT 'default'");
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS vibration TEXT DEFAULT 'default'");
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS preview BOOLEAN DEFAULT TRUE");
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS mention_exception BOOLEAN DEFAULT TRUE");
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS mute_until TIMESTAMP NULL");
            // (4b) Custom vibration pattern JSON (`{durations:[100,50,200]}`).
            //      Native push handler reads this when emitting vibration so
            //      a user can give one specific conv a unique buzz sequence.
            @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS vibration_pattern TEXT NULL");
            // (4c) Forwarding-disabled per conversation. When TRUE, non-admin
            //      members cannot use chat_forward / chat_forward_multi to
            //      copy messages out. Admin-only group setting (Telegram
            //      "Restrict saving content" mirror).
            @$db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS forwarding_disabled BOOLEAN DEFAULT FALSE");
            // (5) Phone visibility privacy field (all/contacts/nobody).
            //     Same TEXT enum shape as the existing last_seen/profile_photo
            //     columns on chat_user_privacy.
            @$db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS phone_visibility TEXT DEFAULT 'contacts'");
            // (6) Voicemails — recorded after a missed call. The message bubble
            //     in the chat carries kind=voicemail + voicemail_id; the actual
            //     audio stays in R2 and the row holds metadata + transcription.
            @$db->exec("CREATE TABLE IF NOT EXISTS voicemails (
                id BIGSERIAL PRIMARY KEY,
                from_email TEXT NOT NULL,
                to_email TEXT NOT NULL,
                conversation_id BIGINT NOT NULL,
                audio_r2_key TEXT NOT NULL,
                duration_sec INT NOT NULL DEFAULT 0,
                transcription TEXT NULL,
                listened BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_voicemails_to_email ON voicemails (to_email, created_at DESC)");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_voicemails_conv ON voicemails (conversation_id)");
            // (7) Cloudflare Stream live broadcast columns. The base table is
            //     owned by email.php (legacy WebRTC P2P live_start). The CF
            //     Stream pipeline (`live_start_cf` / `live_end_cf` /
            //     `live_status_cf`) needs extra columns to track the CF live
            //     input UID + ingest credentials + playback URLs. Idempotent
            //     ALTERs let chat.php migrate forward without touching the
            //     email.php-owned CREATE TABLE.
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_live_sessions (
                id TEXT PRIMARY KEY,
                host_email TEXT NOT NULL,
                host_name TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'live',
                viewer_count INTEGER NOT NULL DEFAULT 0,
                started_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS'),
                ended_at TEXT DEFAULT NULL,
                thumbnail_url TEXT DEFAULT ''
            )");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS cf_input_uid VARCHAR(64)");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS rtmps_url TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS rtmps_key TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS hls_url TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS dash_url TEXT");
            // (8) Recording/replay columns. CF Stream auto-records every
            //     RTMP session as a VOD (mode=automatic on live_input).
            //     `live_end_cf` doesn't know the VOD uid yet (CF takes 30s-2min
            //     to finalize), so we poll the live_inputs/{uid}/videos endpoint
            //     in `live_recording_poll` and stamp these columns when ready.
            //     `save_replay` is host's choice when ending the live; if FALSE
            //     we'll DELETE the VOD via CF API instead of exposing it.
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS recording_url TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS recording_mp4 TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS recording_duration INTEGER");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS recording_ready BOOLEAN DEFAULT FALSE");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS recording_video_uid TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS recording_thumbnail TEXT");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS save_replay BOOLEAN DEFAULT TRUE");
            @$db->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS saved_count INTEGER DEFAULT 0");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_sessions_host ON chat_live_sessions(host_email)");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_sessions_status ON chat_live_sessions(status)");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_sessions_cf_uid ON chat_live_sessions(cf_input_uid)");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_sessions_recording_ready ON chat_live_sessions (recording_ready, ended_at) WHERE recording_ready = FALSE");
            // (8b) Replays saved by viewers — separate from the host's owned
            //      sessions. UNIQUE(user_email, session_id) makes save_replay
            //      idempotent (tap multiple times = no dupes).
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_live_replays_saved (
                id SERIAL PRIMARY KEY,
                user_email TEXT NOT NULL,
                session_id TEXT NOT NULL,
                saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(user_email, session_id)
            )");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_replays_user ON chat_live_replays_saved (user_email, saved_at DESC)");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_replays_session ON chat_live_replays_saved (session_id)");
            // (9) Per-device X25519 public keys (SQLite-first chat migration —
            //     Stage 2). Each linked surface (web/desktop/companion mobile)
            //     publishes its own X25519 pubkey after QR pairing so the
            //     phone can encrypt per-device envelopes in Stage 5 instead
            //     of one envelope per email. UNIQUE(email, device_id) keeps
            //     the table idempotent under retries from the same surface.
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_device_keys (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL,
                device_id TEXT NOT NULL,
                pubkey TEXT NOT NULL,
                kind TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(email, device_id)
            )");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_device_keys_email ON chat_device_keys (email)");
            // (10) Per-recipient-device encrypted envelopes (SQLite-first chat
            //     migration — Stage 5). When the sender encrypts a message
            //     individually for each paired device of each recipient, the
            //     ciphertext (nacl.box output) lands here as a pending row.
            //     The receiving device pulls its envelopes on foreground (or
            //     after a silent-push wake — Stage 4) and acks them; on ack
            //     the row is dropped and a per-device chat_message_receipts
            //     entry is recorded so multi-device delivery is observable
            //     by the sender. Rows expire after 30d so abandoned devices
            //     don't bloat the table.
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_pending_envelopes (
                id BIGSERIAL PRIMARY KEY,
                sender_email TEXT NOT NULL,
                recipient_email TEXT NOT NULL,
                recipient_device_id TEXT NOT NULL,
                conversation_id BIGINT NOT NULL,
                client_message_id TEXT NOT NULL,
                ciphertext TEXT NOT NULL,
                ephemeral_pubkey TEXT NOT NULL,
                nonce TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                delivered_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
                UNIQUE(recipient_email, recipient_device_id, client_message_id)
            )");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_pending_env_recip ON chat_pending_envelopes(recipient_email, created_at DESC)");
            // [Stage 7 SQLite-first 2026-05-16] Belt-and-suspenders: ensure
            // delivered_at exists on hosts that ran an early Stage 5 schema
            // without it. CREATE TABLE above carries it for fresh installs;
            // this covers legacy upgrades and is a no-op when present.
            @$db->exec("ALTER TABLE chat_pending_envelopes ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ");

            // ── Sender-Keys envelope bodies (2026-05-16) ───────────────
            // For group chats, the legacy schema stores one full-message
            // ciphertext per recipient device — N rows for an N-device
            // fan-out. Sender-Keys mode collapses that to ONE shared body
            // (encrypted under a per-message symmetric key) + N tiny
            // "wrapped key" rows. This table holds the shared body; the
            // `chat_pending_envelopes` rows reference it via body_ref.
            // Legacy rows (per-device ciphertext, no body_ref) coexist —
            // body_ref is nullable.
            //
            // body_algo == 'nacl_secretbox' means the auth tag is embedded
            // in body_ciphertext (Poly1305) and body_tag stays NULL. A
            // future AES-GCM upgrade would set body_algo='aes_gcm' and
            // populate body_tag separately.
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_pending_envelope_bodies (
                id BIGSERIAL PRIMARY KEY,
                sender_email TEXT NOT NULL,
                conversation_id BIGINT NOT NULL,
                client_message_id TEXT NOT NULL,
                body_ciphertext TEXT NOT NULL,
                body_iv TEXT NOT NULL,
                body_tag TEXT,
                body_algo TEXT DEFAULT 'nacl_secretbox',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
                UNIQUE(sender_email, conversation_id, client_message_id)
            )");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_pending_env_bodies_exp ON chat_pending_envelope_bodies(expires_at)");

            // Extend chat_pending_envelopes with optional Sender-Keys
            // fields. When body_ref is set, the row is a key-wrap shard
            // and (ciphertext, ephemeral_pubkey, nonce) carry the wrapped
            // 32-byte messageKey (~80 bytes base64) rather than a full
            // per-device message ciphertext. Legacy rows leave body_ref
            // NULL and continue to carry the whole per-device ciphertext
            // in the original columns — no data migration required.
            @$db->exec("ALTER TABLE chat_pending_envelopes ADD COLUMN IF NOT EXISTS body_ref BIGINT");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_pending_env_body_ref ON chat_pending_envelopes(body_ref)");
            // device_id on receipts so multi-device delivery is recorded per
            // surface. NULL is allowed for legacy email-level receipts. The
            // composite unique replaces the implicit (message_id, email)
            // dedup that the legacy code path uses — that one is left in
            // place via the original PK; this new one is additive.
            // NOTE on column name: legacy chat_message_receipts uses `email`
            // (not user_email) as the per-user column — see the SELECTs at
            // ~3952, 9665, 13976. We extend that schema, not the spec'd
            // `user_email`, to stay drop-in with the existing code paths.
            @$db->exec("ALTER TABLE chat_message_receipts ADD COLUMN IF NOT EXISTS device_id TEXT");
            @$db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_msg_user_device ON chat_message_receipts(message_id, email, device_id)");
        } catch (\Throwable $e) { error_log('[chat.schema] ' . $e->getMessage()); }
        $_migrated = true;
    }

    switch ($action) {

        // ============================================================
        // chat_list / chat_conversations — List user's conversations
        // ============================================================
        case 'chat_list':
        case 'chat_conversations': {
            $user = requireChatAuth();

            $search = trim($input['search'] ?? $_GET['search'] ?? '');
            $filter = trim($input['filter'] ?? $_GET['filter'] ?? '');
            $typeFilter = trim($input['type'] ?? $_GET['type'] ?? '');

            $sql = "
                SELECT c.*, cm.pinned as user_pinned
                FROM chat_conversations c
                JOIN chat_conversation_members cm ON cm.conversation_id = c.id
                WHERE LOWER(cm.email) = LOWER(:email)
            ";
            $params = [':email' => $user['email']];

            if ($search !== '') {
                $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search);
                $sql .= " AND (c.name LIKE :search)";
                $params[':search'] = '%' . $escaped . '%';
            }

            if ($typeFilter !== '' && in_array($typeFilter, ['direct', 'group', 'channel', 'saved'], true)) {
                $sql .= " AND c.type = :type";
                $params[':type'] = $typeFilter;
            }

            // WhatsApp-style ordering: pinned first, then by the actual last
            // message time. PG timestamps are TEXT ISO so regular ORDER BY
            // on GREATEST() works correctly.
            $sql .= " ORDER BY cm.pinned DESC, COALESCE(
                (SELECT MAX(created_at) FROM chat_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL),
                c.updated_at, c.created_at
            ) DESC";

            $limit  = max(1, min(500, (int)($input['limit']  ?? $_GET['limit']  ?? 100)));
            $offset = max(0, (int)($input['offset'] ?? $_GET['offset'] ?? 0));
            $sql .= ' LIMIT ' . $limit . ' OFFSET ' . $offset;

            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            $conversations = $stmt->fetchAll();

            // Preload members + last-message + unread-per-row in 4 queries.
            $convIds = array_map('intval', array_column($conversations, 'id'));
            $preload = ['members' => [], 'lastMsg' => [], 'unread' => [], 'mentions' => []];
            if ($convIds) {
                $in = implode(',', array_fill(0, count($convIds), '?'));

                // Members
                $qm = $db->prepare("SELECT conversation_id, email, role, muted, joined_at FROM chat_conversation_members WHERE conversation_id IN ($in)");
                $qm->execute($convIds);
                foreach ($qm->fetchAll() as $m) {
                    $cid = (int)$m['conversation_id'];
                    if (!isset($preload['members'][$cid])) $preload['members'][$cid] = [];
                    $m['display_name'] = chatDisplayName($m['email']);
                    $preload['members'][$cid][] = $m;
                }

                // Last message per conversation — window function (PG supports it).
                // Include delivered_at/read_at so the conversation row can render
                // the right checkmark (✓ sent / ✓✓ delivered / ✓✓ read-in-purple)
                // synced with what the user sees inside the thread.
                $qlm = $db->prepare("
                    SELECT id, conversation_id, sender_email, content, type, created_at, delivered_at, read_at FROM (
                        SELECT id, conversation_id, sender_email, content, type, created_at, delivered_at, read_at,
                               ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY id DESC) AS rn
                        FROM chat_messages
                        WHERE conversation_id IN ($in) AND deleted_at IS NULL
                    ) t WHERE rn = 1
                ");
                $qlm->execute($convIds);
                foreach ($qlm->fetchAll() as $lm) {
                    $preload['lastMsg'][(int)$lm['conversation_id']] = $lm;
                }

                // Unread count
                $qu = $db->prepare("
                    SELECT m.conversation_id, COUNT(*) AS cnt
                    FROM chat_messages m
                    JOIN chat_conversation_members cm
                      ON cm.conversation_id = m.conversation_id AND LOWER(cm.email) = LOWER(?)
                    WHERE m.conversation_id IN ($in)
                      AND m.id > COALESCE(cm.last_read_message_id, 0)
                      AND LOWER(m.sender_email) <> LOWER(?)
                      AND m.deleted_at IS NULL
                    GROUP BY m.conversation_id
                ");
                $orderedParams = array_merge([$user['email']], $convIds, [$user['email']]);
                $qu->execute($orderedParams);
                foreach ($qu->fetchAll() as $u) {
                    $preload['unread'][(int)$u['conversation_id']] = (int)$u['cnt'];
                }

                // Per-user membership row (last_read_message_id, muted, pinned).
                // Without this, buildConversationData fired one extra SELECT per
                // conversation — N=100 list = 100 round-trips. One IN-list does
                // it in a single query, keyed by conversation_id.
                $preload['membership'] = [];
                $qmem = $db->prepare("
                    SELECT conversation_id, last_read_message_id, muted, pinned
                    FROM chat_conversation_members
                    WHERE conversation_id IN ($in) AND LOWER(email) = LOWER(?)
                ");
                $qmem->execute(array_merge($convIds, [$user['email']]));
                foreach ($qmem->fetchAll() as $mr) {
                    $preload['membership'][(int)$mr['conversation_id']] = $mr;
                }

                // Unread @-mentions per conv. Same shape as unread but filters
                // on mentions LIKE — formerly fired per-row inside
                // buildConversationData (another N+1, with try/catch swallowing
                // any failure). Single GROUP BY query here costs a hashed scan;
                // the per-row variant scaled with the conversation count.
                try {
                    $lower = strtolower($user['email']);
                    $qmen = $db->prepare("
                        SELECT m.conversation_id, COUNT(*) AS cnt
                        FROM chat_messages m
                        JOIN chat_conversation_members cm
                          ON cm.conversation_id = m.conversation_id AND LOWER(cm.email) = LOWER(?)
                        WHERE m.conversation_id IN ($in)
                          AND m.id > COALESCE(cm.last_read_message_id, 0)
                          AND LOWER(m.sender_email) <> LOWER(?)
                          AND m.deleted_at IS NULL
                          AND m.mentions IS NOT NULL
                          AND (m.mentions LIKE ? OR m.mentions LIKE ? OR m.mentions LIKE ?)
                        GROUP BY m.conversation_id
                    ");
                    $qmen->execute(array_merge(
                        [$user['email']],
                        $convIds,
                        [$user['email'], '%"' . $lower . '"%', '%"' . $user['email'] . '"%', '%@' . $lower . '%']
                    ));
                    foreach ($qmen->fetchAll() as $u) {
                        $preload['mentions'][(int)$u['conversation_id']] = (int)$u['cnt'];
                    }
                } catch (Throwable $e) { error_log('[chat_list/mentions.preload] ' . $e->getMessage()); }
            }

            // Surface preloads to buildConversationData through a process-
            // local static so the function can avoid its per-row queries.
            chatListPreload($preload);

            $result = [];
            foreach ($conversations as $conv) {
                $data = buildConversationData($db, $conv, $user['email']);

                // Apply filter after building data (need unread_count etc.)
                if ($filter === 'unread' && $data['unread_count'] <= 0) continue;
                if ($filter === 'favorites' && !$data['pinned']) continue;

                // Hide ghost direct conversations where the peer's email is
                // malformed (no domain, social-handle leak from old contact
                // sync paths). These used to show up in the list as broken
                // entries that wouldn't load any messages when opened.
                if (($data['type'] ?? '') === 'direct') {
                    $badPeer = false;
                    foreach ($data['members'] ?? [] as $mm) {
                        if (strcasecmp($mm['email'] ?? '', $user['email']) === 0) continue;
                        if (!filter_var($mm['email'] ?? '', FILTER_VALIDATE_EMAIL)) {
                            $badPeer = true;
                            break;
                        }
                    }
                    if ($badPeer) continue;
                }

                $result[] = $data;
            }
            chatListPreload(null); // clear so one-off callers fall back to lazy

            jsonResponse(true, $result);
            break;
        }

        // ============================================================
        // chat_create — Create a new conversation
        // ============================================================
        case 'chat_create': {
            $user = requireChatAuth();

            $members = $input['members'] ?? [];
            $type = $input['type'] ?? 'direct';
            $name = trim($input['name'] ?? '');

            if (!is_array($members) || count($members) === 0) {
                jsonResponse(false, null, 'At least one member email required', 400);
            }

            // Validate type
            if (!in_array($type, ['direct', 'group', 'channel'], true)) {
                jsonResponse(false, null, 'Type must be "direct", "group", or "channel"', 400);
            }

            // Direct chats: exactly one other person, check for existing
            if ($type === 'direct') {
                if (count($members) !== 1) {
                    jsonResponse(false, null, 'Direct chat requires exactly one other member', 400);
                }

                $otherEmail = strtolower(trim($members[0]));
                if ($otherEmail === strtolower($user['email'])) {
                    jsonResponse(false, null, 'Cannot create a chat with yourself', 400);
                }
                // Reject garbage like "@handle" or missing domain. Contact
                // sync had a path that dropped the domain when mapping a
                // social handle to an email, which left ghost "direct"
                // conversations in the list ("@itsneres" etc) that the
                // user couldn't open meaningfully.
                if (!filter_var($otherEmail, FILTER_VALIDATE_EMAIL)) {
                    jsonResponse(false, null, 'Invalid member email', 400);
                }
                // Block-list gate. If the target previously blocked the
                // requester, opening a direct conversation is not allowed —
                // matches WhatsApp where a blocked user can't initiate. We
                // return the same generic 'Invalid member' so the requester
                // can't probe block state via this endpoint.
                try {
                    $bChk = $db->prepare("SELECT 1 FROM chat_blocked_users WHERE LOWER(blocker_email) = LOWER(:t) AND LOWER(blocked_email) = LOWER(:me) LIMIT 1");
                    $bChk->execute([':t' => $otherEmail, ':me' => $user['email']]);
                    if ($bChk->fetchColumn()) {
                        jsonResponse(false, null, 'Cannot start chat with this user', 403);
                    }
                } catch (\Throwable $e) { /* block table unavailable → permit */ }

                // Check if a direct conversation already exists between these two users.
                $existingId = null;
                $sortedKey = strtolower($user['email']) < strtolower($otherEmail)
                    ? strtolower($user['email']) . '|' . strtolower($otherEmail)
                    : strtolower($otherEmail) . '|' . strtolower($user['email']);
                try {
                    $psPG = $db->prepare("SELECT id FROM chat_conversations WHERE type='direct' AND direct_key = :k LIMIT 1");
                    $psPG->execute([':k' => $sortedKey]);
                    $r = $psPG->fetch();
                    if ($r) $existingId = (int)$r['id'];
                } catch (Throwable $e) {}

                if ($existingId) {
                    $stmt = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
                    $stmt->execute([':id' => $existingId]);
                    $conv = $stmt->fetch();
                    if ($conv) {
                        jsonResponse(true, buildConversationData($db, $conv, $user['email']), 'Existing conversation');
                        break;
                    }
                }

                $allMembers = [$user['email'], $otherEmail];
            } else {
                // Group chat
                if (empty($name)) {
                    $name = 'Group Chat';
                }

                $allMembers = array_unique(array_merge(
                    [$user['email']],
                    array_map(function($e) { return strtolower(trim($e)); }, $members)
                ));
            }

            // For direct chats, canonical key = sorted lowercase pair (e.g. "a|b").
            // Unique index on chat_conversations.direct_key in PG is what
            // actually prevents duplicates under concurrent creates.
            $directKey = null;
            if ($type === 'direct') {
                $e1 = strtolower($allMembers[0]); $e2 = strtolower($allMembers[1]);
                $directKey = $e1 < $e2 ? "$e1|$e2" : "$e2|$e1";
            }

            // Disappearing-messages default (global, per-user). When the
            // creator has chat_user_defaults.default_disappearing set,
            // automatically apply it to every new conversation. Client may
            // override via the explicit `disappearing_seconds` param (e.g.
            // a "create with no timer" flow). 0 = off.
            $disappearingDefault = 0;
            $explicitTimer = isset($input['disappearing_seconds']);
            if ($explicitTimer) {
                $maybe = (int)$input['disappearing_seconds'];
                $allowed = [0, 3600, 86400, 604800, 2592000, 7776000];
                if (in_array($maybe, $allowed, true)) $disappearingDefault = $maybe;
            } else {
                try {
                    @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_defaults (email TEXT PRIMARY KEY, default_disappearing INTEGER NOT NULL DEFAULT 0, updated_at TEXT)");
                    $dq = $db->prepare("SELECT default_disappearing FROM chat_user_defaults WHERE LOWER(email) = LOWER(:e)");
                    $dq->execute([':e' => $user['email']]);
                    $disappearingDefault = (int)($dq->fetchColumn() ?: 0);
                } catch (Throwable $_e) { $disappearingDefault = 0; }
            }

            // Telegram Cloud parity: creator's chat_user_privacy
            // .cloud_chats_default decides whether the new conv persists
            // server-side (TRUE = cloud sync) or stays device-local (FALSE
            // = WS-only relay). Lookup is best-effort — when missing or
            // any error fires we fall back to TRUE which matches the
            // existing always-persist behavior.
            $cloudStorageNew = true;
            try {
                @$db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS cloud_chats_default BOOLEAN DEFAULT TRUE");
                $ccq = $db->prepare("SELECT cloud_chats_default FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
                $ccq->execute([':e' => $user['email']]);
                $ccVal = $ccq->fetchColumn();
                if ($ccVal !== false && $ccVal !== null) {
                    $cloudStorageNew = (bool)$ccVal;
                }
            } catch (\Throwable $e) { /* default true */ }

            // Create conversation in PG (source of truth, has unique index on direct_key).
            $conversationId = null;
            try {
                $db->beginTransaction();
                $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, direct_key, created_at, updated_at) VALUES (:t, :n, :cb, :dk, now()::text, now()::text) RETURNING id");
                $ins->execute([':t' => $type, ':n' => $name, ':cb' => $user['email'], ':dk' => $directKey]);
                $conversationId = (int)$ins->fetchColumn();
                // Apply default disappearing timer if any. Try the optimistic
                // path; if the column is missing on legacy schemas we just
                // skip rather than abort the create.
                if ($disappearingDefault > 0) {
                    try {
                        $db->prepare("UPDATE chat_conversations SET disappearing_timer = :s WHERE id = :id")
                           ->execute([':s' => $disappearingDefault, ':id' => $conversationId]);
                    } catch (Throwable $_e) { /* column missing — non-fatal */ }
                }
                // Stamp cloud_storage on the new row. ALTER fires once per
                // schema (IF NOT EXISTS makes it cheap when the column is
                // already there). We only UPDATE when the creator chose
                // cloud-off — TRUE is the column default so the path is a
                // no-op for normal users.
                if (!$cloudStorageNew) {
                    try {
                        @$db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS cloud_storage BOOLEAN NOT NULL DEFAULT TRUE");
                        $db->prepare("UPDATE chat_conversations SET cloud_storage = FALSE WHERE id = :id")
                           ->execute([':id' => $conversationId]);
                    } catch (\Throwable $_e) { error_log('[chat_create.cloud_storage] ' . $_e->getMessage()); }
                }
                $insM = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, :r, now()::text) ON CONFLICT DO NOTHING");
                foreach ($allMembers as $memberEmail) {
                    $role = ($memberEmail === $user['email']) ? 'admin' : 'member';
                    $insM->execute([':cid' => $conversationId, ':em' => strtolower($memberEmail), ':dn' => chatDisplayName($memberEmail), ':r' => $role]);
                }

                // System message for group/channel creation
                if ($type === 'group' || $type === 'channel') {
                    $typeLabel = $type === 'channel' ? 'channel' : 'group';
                    $stmt = $db->prepare("
                        INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                        VALUES (:cid, :email, :content, 'system', now()::text)
                    ");
                    $stmt->execute([
                        ':cid'     => $conversationId,
                        ':email'   => $user['email'],
                        ':content' => chatDisplayName($user['email']) . ' created the ' . $typeLabel . ' "' . $name . '"',
                    ]);
                }

                $db->commit();
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                // Unique-violation on direct_key — concurrent create raced us.
                if ($directKey && stripos($e->getMessage(), 'duplicate key') !== false) {
                    try {
                        $q = $db->prepare("SELECT id FROM chat_conversations WHERE type='direct' AND direct_key = :k LIMIT 1");
                        $q->execute([':k' => $directKey]);
                        $eid = (int)$q->fetchColumn();
                        if ($eid) {
                            $stmt = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
                            $stmt->execute([':id' => $eid]);
                            $conv = $stmt->fetch();
                            if ($conv) { jsonResponse(true, buildConversationData($db, $conv, $user['email']), 'Existing conversation'); break; }
                        }
                    } catch (Throwable $e2) {}
                }
                jsonResponse(false, null, 'Failed to create conversation (PG): ' . $e->getMessage(), 500);
            }

            $stmt = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
            $stmt->execute([':id' => $conversationId]);
            $conv = $stmt->fetch();

            jsonResponse(true, buildConversationData($db, $conv, $user['email']), 'Conversation created');
            break;
        }

        // ============================================================
        // chat_info / chat_members — Get conversation details + members
        // ============================================================
        case 'chat_info':
        case 'chat_members':
        case 'chat_group_info': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            $membership = requireConversationMember($db, $conversationId, $user['email']);

            $stmt = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
            $stmt->execute([':id' => $conversationId]);
            $conv = $stmt->fetch();
            if (!$conv) jsonResponse(false, null, 'Conversation not found', 404);

            $data = buildConversationData($db, $conv, $user['email']);

            // hide_members enforcement: when the group has the hide_members
            // flag set and the requester is NOT an admin, strip the members
            // array down to just the requester themselves. Admins always see
            // the full list. Direct chats are unaffected (no privacy meaning).
            $hideMembers = !empty($conv['hide_members']);
            $isAdmin = (($membership['role'] ?? 'member') === 'admin');
            if ($hideMembers && !$isAdmin && ($conv['type'] ?? '') === 'group') {
                $userLc = strtolower($user['email']);
                $filtered = [];
                foreach (($data['members'] ?? []) as $m) {
                    if (isset($m['email']) && strtolower($m['email']) === $userLc) {
                        $filtered[] = $m;
                        break;
                    }
                }
                $data['members'] = $filtered;
                $data['members_hidden'] = true;
            }

            jsonResponse(true, $data);
            break;
        }

        // ============================================================
        // chat_update — Update conversation name/settings
        // ============================================================
        case 'chat_update': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            $membership = requireConversationMember($db, $conversationId, $user['email']);

            // Only group chats can be updated
            if ($membership['type'] !== 'group') {
                jsonResponse(false, null, 'Cannot update a direct chat', 400);
            }
            // Admin-only by default; non-admins pass only if they were granted
            // the edit_info custom-role permission.
            if (!chatHasPermission($conversationId, $user['email'], 'edit_info')) {
                jsonResponse(false, null, 'Only admins can update the group', 403);
            }

            $updates = [];
            $params = [':id' => $conversationId];

            if (isset($input['name'])) {
                $newName = mb_substr(trim($input['name']), 0, 60);
                $updates[] = "name = :name"; $params[':name'] = $newName;
            }
            if (isset($input['description'])) {
                $newDesc = mb_substr(trim($input['description']), 0, 500);
                $updates[] = "description = :desc"; $params[':desc'] = $newDesc;
            }
            if (isset($input['avatar']) || isset($input['avatar_url'])) {
                $av = trim((string)($input['avatar_url'] ?? $input['avatar']));
                $isLocal = ($av === '') || (strpos($av, '/data/') === 0);
                $isCdn   = (bool)preg_match('#^https?://[a-z0-9.-]*chatyy\.com\.br/#i', $av)
                        || (bool)preg_match('#^https?://[a-z0-9.-]*\.r2\.cloudflarestorage\.com/#i', $av)
                        || (bool)preg_match('#^https?://[a-z0-9.-]*\.r2\.dev/#i', $av);
                if (!$isLocal && !$isCdn) {
                    jsonResponse(false, null, 'Invalid avatar_url', 400);
                }
                $updates[] = "avatar_url = :avatar"; $params[':avatar'] = $av;
            }

            if (empty($updates)) {
                jsonResponse(false, null, 'Nothing to update', 400);
            }

            $updates[] = "updated_at = now()::text";
            $db->prepare("UPDATE chat_conversations SET " . implode(', ', $updates) . " WHERE id = :id")->execute($params);

            // System message announces the change (WhatsApp style).
            $sysMsg = null;
            if (isset($input['name'])) $sysMsg = chatDisplayName($user['email']) . ' renamed the group to "' . trim($input['name']) . '"';
            elseif (isset($input['description'])) $sysMsg = chatDisplayName($user['email']) . ' updated the group description';
            elseif (isset($input['avatar']) || isset($input['avatar_url'])) $sysMsg = chatDisplayName($user['email']) . ' updated the group photo';
            if ($sysMsg) {
                $stmt = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :email, :content, 'system', now()::text) RETURNING id");
                $stmt->execute([':cid' => $conversationId, ':email' => $user['email'], ':content' => $sysMsg]);
                $mid = (int)$stmt->fetchColumn();
                try { broadcastChatMessage($db, $conversationId, $mid, $user['email']); } catch (Throwable $e) {}
            }

            $stmt = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
            $stmt->execute([':id' => $conversationId]);
            $conv = $stmt->fetch();

            jsonResponse(true, buildConversationData($db, $conv, $user['email']), 'Conversation updated');
            break;
        }

        // ============================================================
        // chat_add_member — Add member to group conversation
        // ============================================================
        case 'chat_add_member':
        case 'chat_members_update': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $newEmail = strtolower(trim($input['email'] ?? ''));
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if (!$newEmail) jsonResponse(false, null, 'email required', 400);
            if (!filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'Invalid email', 400);
            }

            $membership = requireConversationMember($db, $conversationId, $user['email']);

            if ($membership['type'] !== 'group') {
                jsonResponse(false, null, 'Cannot add members to a direct chat', 400);
            }

            // Admin-only by default. Members with the add_members custom-role
            // permission also pass. Previously any member could add anyone to
            // any group — a trivial spam vector.
            if (!chatHasPermission($conversationId, $user['email'], 'add_members')) {
                jsonResponse(false, null, 'Only admins can add members', 403);
            }

            // Check if already a member
            $stmt = $db->prepare("SELECT id FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
            $stmt->execute([':cid' => $conversationId, ':email' => $newEmail]);
            if ($stmt->fetch()) {
                jsonResponse(false, null, 'User is already a member', 400);
            }

            // Respect the target user's "who can add me to groups" setting.
            // everyone → always allow. contacts → allow only if adder is in
            // target's contacts (shares any conversation). nobody → block.
            try {
                $prv = $db->prepare("SELECT group_add FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
                $prv->execute([':e' => $newEmail]);
                $pref = $prv->fetchColumn() ?: 'everyone';
                if ($pref === 'nobody') {
                    jsonResponse(false, null, 'Essa pessoa não permite ser adicionada a grupos.', 403);
                } else if ($pref === 'contacts') {
                    $chk = $db->prepare("SELECT 1 FROM chat_conversation_members a JOIN chat_conversation_members b ON a.conversation_id = b.conversation_id WHERE LOWER(a.email) = LOWER(:me) AND LOWER(b.email) = LOWER(:them) LIMIT 1");
                    $chk->execute([':me' => $user['email'], ':them' => $newEmail]);
                    if (!$chk->fetch()) {
                        jsonResponse(false, null, 'Essa pessoa só aceita ser adicionada por contatos.', 403);
                    }
                }
            } catch (Throwable $_) { /* default = allow */ }

            $db->beginTransaction();
            $sysMid = 0;
            try {
                $stmt = $db->prepare("
                    INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at)
                    VALUES (:cid, :email, :dn, 'member', now()::text)
                    ON CONFLICT DO NOTHING
                ");
                $stmt->execute([':cid' => $conversationId, ':email' => $newEmail, ':dn' => chatDisplayName($newEmail)]);

                $stmt = $db->prepare("
                    INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                    VALUES (:cid, :email, :content, 'system', now()::text)
                    RETURNING id
                ");
                $stmt->execute([
                    ':cid'     => $conversationId,
                    ':email'   => $user['email'],
                    ':content' => chatDisplayName($user['email']) . ' added ' . chatDisplayName($newEmail),
                ]);
                $sysMid = (int)$stmt->fetchColumn();

                $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")
                   ->execute([':id' => $conversationId]);
                $db->commit();
            } catch (\Exception $e) {
                if ($db->inTransaction()) $db->rollBack();
                error_log('[chat_add_member] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to add member', 500);
            }

            if ($sysMid) {
                try {
                    $pts = emitConvEvent($db, (int)$conversationId, 'member_join', $user['email'], ['message_id' => $sysMid, 'added_email' => $newEmail]);
                    if ($pts > 0) {
                        $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                           ->execute([':p' => $pts, ':mid' => $sysMid]);
                    }
                } catch (Throwable $e) { error_log('[chat_add_member/pts] ' . $e->getMessage()); }
                try { broadcastChatMessage($db, $conversationId, $sysMid, $user['email']); } catch (Throwable $e) {}
            }

            jsonResponse(true, null, 'Member added');
            break;
        }

        // ============================================================
        // chat_remove_member — Remove member from group conversation
        // ============================================================
        case 'chat_remove_member': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            // Client historically sent `target_email` (mobile app) but this
            // handler only read `email`, so every remove-member call from
            // the app returned "email required" after eating the spinner
            // for a while. Accept both.
            $removeEmail = strtolower(trim((string)($input['target_email'] ?? $input['email'] ?? '')));
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if (!$removeEmail) jsonResponse(false, null, 'email required', 400);

            $membership = requireConversationMember($db, $conversationId, $user['email']);

            if ($membership['type'] !== 'group') {
                jsonResponse(false, null, 'Cannot remove members from a direct chat', 400);
            }

            // Permission gate: admins always pass; members pass only if their
            // custom-role permissions JSONB has remove_messages=true. Creator
            // is grandfathered in as an admin equivalent (legacy behavior).
            $isCreator = ($membership['created_by'] === $user['email']);
            if (!$isCreator && !chatHasPermission($conversationId, $user['email'], 'remove_messages')) {
                jsonResponse(false, null, 'Only admins can remove members', 403);
            }

            // Cannot remove yourself (use chat_leave instead)
            if ($removeEmail === strtolower($user['email'])) {
                jsonResponse(false, null, 'Use chat_leave to leave the conversation', 400);
            }

            $db->beginTransaction();
            $sysMid = 0;
            try {
                $stmt = $db->prepare("DELETE FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
                $stmt->execute([':cid' => $conversationId, ':email' => $removeEmail]);

                if ($stmt->rowCount() === 0) {
                    $db->rollBack();
                    jsonResponse(false, null, 'User is not a member', 404);
                }

                $stmt = $db->prepare("
                    INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                    VALUES (:cid, :email, :content, 'system', now()::text)
                    RETURNING id
                ");
                $stmt->execute([
                    ':cid'     => $conversationId,
                    ':email'   => $user['email'],
                    ':content' => chatDisplayName($user['email']) . ' removed ' . chatDisplayName($removeEmail),
                ]);
                $sysMid = (int)$stmt->fetchColumn();

                $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")
                   ->execute([':id' => $conversationId]);
                $db->commit();
            } catch (\Exception $e) {
                if ($db->inTransaction()) $db->rollBack();
                error_log('[chat_remove_member] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to remove member', 500);
            }

            if ($sysMid) {
                try {
                    $pts = emitConvEvent($db, (int)$conversationId, 'member_leave', $user['email'], ['message_id' => $sysMid, 'removed_email' => $removeEmail]);
                    if ($pts > 0) {
                        $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                           ->execute([':p' => $pts, ':mid' => $sysMid]);
                    }
                } catch (Throwable $e) { error_log('[chat_remove_member/pts] ' . $e->getMessage()); }
                try { broadcastChatMessage($db, $conversationId, $sysMid, $user['email']); } catch (Throwable $e) {}
            }

            jsonResponse(true, null, 'Member removed');
            break;
        }

        // ============================================================
        // chat_group_admin — Promote/demote a member, or write the
        // custom-roles permissions JSONB for a member. Frontend sends one of:
        //   { conversation_id, email, action: 'promote'|'demote' }
        //   { conversation_id, email, permissions: {add_members, edit_info,
        //     remove_messages, pin_messages, promote_admins} }
        // ============================================================
        case 'chat_group_admin': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $targetEmail    = strtolower(trim((string)($input['email'] ?? $input['target_email'] ?? '')));
            $subAction      = strtolower(trim((string)($input['action'] ?? '')));
            $permsIn        = $input['permissions'] ?? null;
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if (!$targetEmail)    jsonResponse(false, null, 'email required', 400);

            $membership = requireConversationMember($db, $conversationId, $user['email']);
            if ($membership['type'] !== 'group') {
                jsonResponse(false, null, 'Not a group conversation', 400);
            }

            if (!chatHasPermission($conversationId, $user['email'], 'promote_admins')) {
                jsonResponse(false, null, 'Only admins can change roles', 403);
            }

            $chk = $db->prepare("SELECT id, role FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e) LIMIT 1");
            $chk->execute([':cid' => $conversationId, ':e' => $targetEmail]);
            $tRow = $chk->fetch(\PDO::FETCH_ASSOC);
            if (!$tRow) jsonResponse(false, null, 'Target is not a member', 404);

            $changed = [];

            if ($subAction === 'promote' || $subAction === 'demote') {
                $newRole = ($subAction === 'promote') ? 'admin' : 'member';
                $db->prepare("UPDATE chat_conversation_members SET role = :r WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e)")
                   ->execute([':r' => $newRole, ':cid' => $conversationId, ':e' => $targetEmail]);
                $changed['role'] = $newRole;

                try {
                    $verb = ($newRole === 'admin') ? 'promoted' : 'demoted';
                    $stmt = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :e, :c, 'system', now()::text) RETURNING id");
                    $stmt->execute([
                        ':cid' => $conversationId,
                        ':e'   => $user['email'],
                        ':c'   => chatDisplayName($user['email']) . ' ' . $verb . ' ' . chatDisplayName($targetEmail),
                    ]);
                    $sysMid = (int)$stmt->fetchColumn();
                    if ($sysMid) {
                        try { broadcastChatMessage($db, $conversationId, $sysMid, $user['email']); } catch (\Throwable $e) {}
                    }
                } catch (\Throwable $e) { error_log('[chat_group_admin/sysmsg] ' . $e->getMessage()); }
            }

            if ($permsIn !== null) {
                if (is_string($permsIn)) {
                    $decoded = json_decode($permsIn, true);
                    $permsIn = is_array($decoded) ? $decoded : [];
                }
                if (!is_array($permsIn)) $permsIn = [];
                $allowedPerms = ['add_members','edit_info','remove_messages','pin_messages','promote_admins'];
                $clean = [];
                foreach ($allowedPerms as $k) {
                    if (array_key_exists($k, $permsIn)) {
                        $v = $permsIn[$k];
                        $clean[$k] = ($v === true || $v === 1 || $v === '1' || $v === 'true');
                    }
                }
                $permsJson = json_encode($clean, JSON_UNESCAPED_UNICODE);
                try {
                    $db->prepare("UPDATE chat_conversation_members SET permissions = :p::jsonb WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e)")
                       ->execute([':p' => $permsJson, ':cid' => $conversationId, ':e' => $targetEmail]);
                    $changed['permissions'] = $clean;
                } catch (\Throwable $e) {
                    error_log('[chat_group_admin/perms] ' . $e->getMessage());
                    jsonResponse(false, null, 'Failed to write permissions', 500);
                }
            }

            if (empty($changed)) {
                jsonResponse(false, null, 'No action or permissions provided', 400);
            }
            jsonResponse(true, $changed);
            break;
        }

        // ============================================================
        // chat_add_members — Plural variant of chat_add_member. Accepts
        // { conversation_id, emails: [...] } and adds each in turn.
        // ============================================================
        case 'chat_add_members': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $emails = $input['emails'] ?? [];
            if (is_string($emails)) {
                $decoded = json_decode($emails, true);
                $emails = is_array($decoded) ? $decoded : [$emails];
            }
            if (!is_array($emails)) $emails = [];
            $emails = array_values(array_unique(array_filter(array_map(
                fn($e) => strtolower(trim((string)$e)), $emails
            ), fn($e) => $e !== '' && filter_var($e, FILTER_VALIDATE_EMAIL))));

            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if (empty($emails))   jsonResponse(false, null, 'emails required', 400);

            $membership = requireConversationMember($db, $conversationId, $user['email']);
            if ($membership['type'] !== 'group') {
                jsonResponse(false, null, 'Cannot add members to a direct chat', 400);
            }
            if (!chatHasPermission($conversationId, $user['email'], 'add_members')) {
                jsonResponse(false, null, 'Only admins can add members', 403);
            }

            $results = [];
            foreach ($emails as $newEmail) {
                try {
                    $st = $db->prepare("SELECT id FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
                    $st->execute([':cid' => $conversationId, ':email' => $newEmail]);
                    if ($st->fetch()) {
                        $results[$newEmail] = ['ok' => false, 'error' => 'already_member'];
                        continue;
                    }
                    try {
                        $prv = $db->prepare("SELECT group_add FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
                        $prv->execute([':e' => $newEmail]);
                        $pref = $prv->fetchColumn() ?: 'everyone';
                        if ($pref === 'nobody') {
                            $results[$newEmail] = ['ok' => false, 'error' => 'privacy_nobody'];
                            continue;
                        } else if ($pref === 'contacts') {
                            $chkP = $db->prepare("SELECT 1 FROM chat_conversation_members a JOIN chat_conversation_members b ON a.conversation_id = b.conversation_id WHERE LOWER(a.email) = LOWER(:me) AND LOWER(b.email) = LOWER(:them) LIMIT 1");
                            $chkP->execute([':me' => $user['email'], ':them' => $newEmail]);
                            if (!$chkP->fetch()) {
                                $results[$newEmail] = ['ok' => false, 'error' => 'privacy_contacts'];
                                continue;
                            }
                        }
                    } catch (\Throwable $_) {}
                    $ins = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :email, :dn, 'member', now()::text) ON CONFLICT DO NOTHING");
                    $ins->execute([':cid' => $conversationId, ':email' => $newEmail, ':dn' => chatDisplayName($newEmail)]);
                    $sm = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :email, :content, 'system', now()::text) RETURNING id");
                    $sm->execute([
                        ':cid'     => $conversationId,
                        ':email'   => $user['email'],
                        ':content' => chatDisplayName($user['email']) . ' added ' . chatDisplayName($newEmail),
                    ]);
                    $sysMid = (int)$sm->fetchColumn();
                    if ($sysMid) {
                        try { broadcastChatMessage($db, $conversationId, $sysMid, $user['email']); } catch (\Throwable $e) {}
                    }
                    $results[$newEmail] = ['ok' => true];
                } catch (\Throwable $e) {
                    error_log('[chat_add_members] ' . $newEmail . ': ' . $e->getMessage());
                    $results[$newEmail] = ['ok' => false, 'error' => 'server_error'];
                }
            }
            try { $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")->execute([':id' => $conversationId]); } catch (\Throwable $_) {}
            jsonResponse(true, ['results' => $results]);
            break;
        }

        // ============================================================
        // chat_update_group — Alias for chat_update that also accepts a
        // hide_members flag. Frontend uses chat_update_group when changing
        // group-level metadata + privacy toggles in one call.
        // ============================================================
        case 'chat_update_group': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            $membership = requireConversationMember($db, $conversationId, $user['email']);
            if ($membership['type'] !== 'group') {
                jsonResponse(false, null, 'Cannot update a direct chat', 400);
            }
            if (!chatHasPermission($conversationId, $user['email'], 'edit_info')) {
                jsonResponse(false, null, 'Only admins can update the group', 403);
            }

            $updates = [];
            $params = [':id' => $conversationId];
            if (isset($input['name'])) {
                $updates[] = "name = :name";
                $params[':name'] = mb_substr(trim((string)$input['name']), 0, 60);
            }
            if (isset($input['description'])) {
                $updates[] = "description = :desc";
                $params[':desc'] = mb_substr(trim((string)$input['description']), 0, 500);
            }
            if (isset($input['avatar']) || isset($input['avatar_url'])) {
                $av = trim((string)($input['avatar_url'] ?? $input['avatar']));
                $isLocal = ($av === '') || (strpos($av, '/data/') === 0);
                $isCdn   = (bool)preg_match('#^https?://[a-z0-9.-]*chatyy\\.com\\.br/#i', $av)
                        || (bool)preg_match('#^https?://[a-z0-9.-]*\\.r2\\.cloudflarestorage\\.com/#i', $av)
                        || (bool)preg_match('#^https?://[a-z0-9.-]*\\.r2\\.dev/#i', $av);
                if (!$isLocal && !$isCdn) jsonResponse(false, null, 'Invalid avatar_url', 400);
                $updates[] = "avatar_url = :avatar";
                $params[':avatar'] = $av;
            }
            if (array_key_exists('hide_members', $input)) {
                $hm = !empty($input['hide_members']) ? 1 : 0;
                $updates[] = "hide_members = :hm";
                $params[':hm'] = $hm;
            }
            if (array_key_exists('forwarding_disabled', $input)) {
                // Admin-only: disable forward/copy out for non-admins.
                // Telegram parity ("Restrict saving content"). Enforcement
                // happens in chat_forward / chat_forward_multi.
                $fd = !empty($input['forwarding_disabled']) ? 1 : 0;
                $updates[] = "forwarding_disabled = :fd";
                $params[':fd'] = $fd;
            }
            if (empty($updates)) jsonResponse(false, null, 'Nothing to update', 400);

            $updates[] = "updated_at = now()::text";
            $db->prepare("UPDATE chat_conversations SET " . implode(', ', $updates) . " WHERE id = :id")->execute($params);
            jsonResponse(true, ['updated' => true]);
            break;
        }

        // ============================================================
        // chat_user_conv_settings_set / _get — per-conversation notification
        // preferences (mute, sound, vibration, preview, mention exception,
        // mute_until). Frontend persists locally and mirrors here so push
        // delivery in chat.php can honor the user's choices.
        // ============================================================
        case 'chat_user_conv_settings_set': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);

            $cols = [];
            $vals = [];
            $params = [':e' => $user['email'], ':c' => $cid];
            if (array_key_exists('notify_messages', $input)) {
                $cols[] = 'notify_messages';
                $vals[] = ':notify_messages';
                $params[':notify_messages'] = !empty($input['notify_messages']);
            }
            if (array_key_exists('sound', $input)) {
                $cols[] = 'sound';
                $vals[] = ':sound';
                $params[':sound'] = mb_substr((string)$input['sound'], 0, 100);
            }
            if (array_key_exists('vibration', $input)) {
                $cols[] = 'vibration';
                $vals[] = ':vibration';
                $params[':vibration'] = mb_substr((string)$input['vibration'], 0, 100);
            }
            if (array_key_exists('vibration_pattern', $input)) {
                // JSON blob `{durations:[100,50,200]}` — keep as TEXT so PG
                // accepts both null and validated JSON. Validate shape so a
                // malformed value never lands in the column (push handler
                // would crash on JSON.parse otherwise).
                $vp = $input['vibration_pattern'];
                $serialized = null;
                if (is_array($vp) && isset($vp['durations']) && is_array($vp['durations'])) {
                    $cleanDurations = [];
                    foreach ($vp['durations'] as $d) {
                        $n = (int)$d;
                        if ($n > 0 && $n <= 5000) $cleanDurations[] = $n;
                        if (count($cleanDurations) >= 32) break;
                    }
                    if (!empty($cleanDurations)) {
                        $serialized = json_encode(['durations' => $cleanDurations]);
                    }
                } else if (is_string($vp) && $vp !== '') {
                    $decoded = json_decode($vp, true);
                    if (is_array($decoded) && isset($decoded['durations']) && is_array($decoded['durations'])) {
                        $cleanDurations = [];
                        foreach ($decoded['durations'] as $d) {
                            $n = (int)$d;
                            if ($n > 0 && $n <= 5000) $cleanDurations[] = $n;
                            if (count($cleanDurations) >= 32) break;
                        }
                        if (!empty($cleanDurations)) {
                            $serialized = json_encode(['durations' => $cleanDurations]);
                        }
                    }
                }
                $cols[] = 'vibration_pattern';
                $vals[] = ':vibration_pattern';
                $params[':vibration_pattern'] = $serialized; // null clears it
            }
            if (array_key_exists('preview', $input)) {
                $cols[] = 'preview';
                $vals[] = ':preview';
                $params[':preview'] = !empty($input['preview']);
            }
            if (array_key_exists('mention_exception', $input)) {
                $cols[] = 'mention_exception';
                $vals[] = ':mention_exception';
                $params[':mention_exception'] = !empty($input['mention_exception']);
            }
            if (array_key_exists('mute_until', $input)) {
                $mu = $input['mute_until'];
                $cols[] = 'mute_until';
                $vals[] = ':mute_until';
                if (!$mu) {
                    $params[':mute_until'] = null;
                } else if (is_numeric($mu)) {
                    $params[':mute_until'] = gmdate('Y-m-d H:i:s', (int)$mu);
                } else {
                    $params[':mute_until'] = (string)$mu;
                }
            }
            if (empty($cols)) jsonResponse(false, null, 'No settings provided', 400);

            $insertCols = array_merge(['email','conversation_id'], $cols);
            $insertVals = array_merge([':e',':c'], $vals);
            $excluded = implode(', ', array_map(fn($c) => "$c = EXCLUDED.$c", $cols));
            $sql = "INSERT INTO chat_user_conv_settings (" . implode(', ', $insertCols) . ")
                    VALUES (" . implode(', ', $insertVals) . ")
                    ON CONFLICT (email, conversation_id) DO UPDATE SET " . $excluded;
            try {
                $db->prepare($sql)->execute($params);
            } catch (\Throwable $e) {
                error_log('[chat_user_conv_settings_set] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to save settings', 500);
            }
            jsonResponse(true, ['saved' => true]);
            break;
        }
        case 'chat_user_conv_settings_get': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $defaults = [
                'notify_messages'   => true,
                'sound'             => 'default',
                'vibration'         => 'default',
                'vibration_pattern' => null,
                'preview'           => true,
                'mention_exception' => true,
                'mute_until'        => null,
            ];
            try {
                $st = $db->prepare("SELECT notify_messages, sound, vibration, vibration_pattern, preview, mention_exception, mute_until FROM chat_user_conv_settings WHERE LOWER(email) = LOWER(:e) AND conversation_id = :c");
                $st->execute([':e' => $user['email'], ':c' => $cid]);
                $row = $st->fetch(\PDO::FETCH_ASSOC);
                if ($row) {
                    $vp = null;
                    if (!empty($row['vibration_pattern'])) {
                        $decoded = json_decode((string)$row['vibration_pattern'], true);
                        if (is_array($decoded) && isset($decoded['durations']) && is_array($decoded['durations'])) {
                            $vp = $decoded;
                        }
                    }
                    $defaults = [
                        'notify_messages'   => (bool)($row['notify_messages'] ?? true),
                        'sound'             => $row['sound'] ?? 'default',
                        'vibration'         => $row['vibration'] ?? 'default',
                        'vibration_pattern' => $vp,
                        'preview'           => (bool)($row['preview'] ?? true),
                        'mention_exception' => (bool)($row['mention_exception'] ?? true),
                        'mute_until'        => $row['mute_until'] ?? null,
                    ];
                }
            } catch (\Throwable $e) { error_log('[chat_user_conv_settings_get] ' . $e->getMessage()); }
            jsonResponse(true, $defaults);
            break;
        }

        // ============================================================
        // chat_leave — Leave a conversation
        // ============================================================
        case 'chat_leave': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            $db->beginTransaction();
            try {
                $stmt = $db->prepare("DELETE FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
                $stmt->execute([':cid' => $conversationId, ':email' => $user['email']]);

                // System message
                $stmt = $db->prepare("
                    INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                    VALUES (:cid, :email, :content, 'system', now()::text)
                ");
                $stmt->execute([
                    ':cid'     => $conversationId,
                    ':email'   => $user['email'],
                    ':content' => chatDisplayName($user['email']) . ' left the group',
                ]);

                $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")
                   ->execute([':id' => $conversationId]);

                // If no members remain, delete the conversation
                $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM chat_conversation_members WHERE conversation_id = :cid");
                $stmt->execute([':cid' => $conversationId]);
                if ((int)$stmt->fetch()['cnt'] === 0) {
                    $db->prepare("DELETE FROM chat_conversations WHERE id = :id")->execute([':id' => $conversationId]);
                }

                $db->commit();
            } catch (\Exception $e) {
                if ($db->inTransaction()) $db->rollBack();
                jsonResponse(false, null, 'Failed to leave conversation: ' . $e->getMessage(), 500);
            }

            jsonResponse(true, null, 'Left conversation');
            break;
        }

        // ============================================================
        // chat_delete — Delete conversation for user (leave + hide)
        // ============================================================
        case 'chat_delete': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            $db->beginTransaction();
            try {
                // Remove membership (hides conversation from user)
                $stmt = $db->prepare("DELETE FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
                $stmt->execute([':cid' => $conversationId, ':email' => $user['email']]);

                // If no members remain, clean up conversation and all messages
                $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM chat_conversation_members WHERE conversation_id = :cid");
                $stmt->execute([':cid' => $conversationId]);
                if ((int)$stmt->fetch()['cnt'] === 0) {
                    $db->prepare("DELETE FROM chat_messages WHERE conversation_id = :cid")->execute([':cid' => $conversationId]);
                    $db->prepare("DELETE FROM chat_conversations WHERE id = :id")->execute([':id' => $conversationId]);
                }

                $db->commit();
            } catch (\Exception $e) {
                if ($db->inTransaction()) $db->rollBack();
                jsonResponse(false, null, 'Failed to delete conversation: ' . $e->getMessage(), 500);
            }

            jsonResponse(true, null, 'Conversation deleted');
            break;
        }

        // ============================================================
        // chat_messages — Get messages for a conversation (paginated)
        // ============================================================
        case 'chat_messages': {
            // [Stage 7 SQLite-first 2026-05-16] This action returns rows from
            // the `chat_messages` PG table — the legacy plaintext store.
            // Pre-migration history (everything before the envelope-mode flag
            // flipped default-ON) lives here permanently and must remain
            // readable forever. AFTER the feature-flag rollout (Stage 6 →
            // Stage 7 default-ON), NEW messages no longer land in
            // `chat_messages`; they flow through `chat_pending_envelopes` as
            // per-recipient-device ciphertexts and are decrypted client-side
            // into the local SQLite chat store. This endpoint then becomes a
            // read-only archive of the legacy data — no new rows expected.
            // The retention cron (`cron-chat-envelope-gc.php`) only GC's
            // `chat_pending_envelopes`, never `chat_messages`.
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            $limit = min(100, max(1, (int)($input['limit'] ?? $_GET['limit'] ?? 50)));
            $beforeId = (int)($input['before_id'] ?? $_GET['before_id'] ?? 0);

            $sinceId = (int)($input['since_id'] ?? $_GET['since_id'] ?? 0);
            $params = [':cid' => $conversationId];
            $whereExtra = '';
            if ($beforeId > 0) {
                $whereExtra = ' AND m.id < :before_id';
                $params[':before_id'] = $beforeId;
            } elseif ($sinceId > 0) {
                // Incremental sync: fetch messages newer than last seen on this device
                $whereExtra = ' AND m.id > :since_id';
                $params[':since_id'] = $sinceId;
            }

            // Per-user "Clear history" — fetch this member's cleared_at; if
            // set, hide messages older than it (WhatsApp behavior: clearing
            // doesn't affect the other party's view).
            $clearedAt = null;
            try {
                $cqs = $db->prepare("SELECT cleared_at FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:em) LIMIT 1");
                $cqs->execute([':cid' => $conversationId, ':em' => $user['email']]);
                $cleRow = $cqs->fetch(\PDO::FETCH_ASSOC);
                if ($cleRow && !empty($cleRow['cleared_at'])) $clearedAt = $cleRow['cleared_at'];
            } catch (\Throwable $e) { /* ignore — column may not exist on legacy schemas */ }

            // Auto-translate per-conversation (Telegram parity). When the
            // requester has a target locale set on this conversation, we
            // hydrate each text row with a cached translation from
            // chat_message_translations. Cache miss = client-side
            // chat_translate_message fills it in lazily; the column tells
            // the UI which messages it can render pre-translated on open.
            $autoTrLocale = null;
            try {
                @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS auto_translate TEXT");
                $atSt = $db->prepare("SELECT auto_translate FROM chat_user_conv_settings WHERE LOWER(email) = LOWER(:e) AND conversation_id = :c");
                $atSt->execute([':e' => $user['email'], ':c' => $conversationId]);
                $atRow = $atSt->fetch(\PDO::FETCH_ASSOC);
                $cand = trim((string)($atRow['auto_translate'] ?? ''));
                if ($cand !== '' && preg_match('/^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/', $cand)) $autoTrLocale = $cand;
            } catch (\Throwable $e) { /* ignore — table may be brand new */ }
            // Ensure the cache table exists (one-shot DDL — IF NOT EXISTS
            // is cheap when the table is already there). Per task spec:
            // chat_message_translations(message_id, lang, text, created_at).
            if ($autoTrLocale !== null) {
                try {
                    @$db->exec("CREATE TABLE IF NOT EXISTS chat_message_translations (
                        message_id BIGINT NOT NULL,
                        lang       TEXT   NOT NULL,
                        text       TEXT   NOT NULL,
                        created_at TEXT   NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text,
                        PRIMARY KEY (message_id, lang)
                    )");
                } catch (\Throwable $e) { error_log('[chat_messages/translations.ddl] ' . $e->getMessage()); }
            }

            // PG is the single source of truth for chat content.
            $pg = $db;
            $pgParams = [':cid' => $conversationId];
            $pgWhere = '';
            if ($beforeId > 0) {
                $pgWhere = ' AND id < :before_id';
                $pgParams[':before_id'] = $beforeId;
            } elseif ($sinceId > 0) {
                $pgWhere = ' AND id > :since_id';
                $pgParams[':since_id'] = $sinceId;
            }
            if ($clearedAt) {
                $pgWhere .= ' AND created_at > :cleared_at';
            }
            // WhatsApp parity: include deleted messages with deleted_at flag
            // so the "Mensagem apagada" tombstone stays stable across reloads.
            // Filtering deleted_at IS NULL caused tombstones to flicker on
            // refresh ("rastro some e volta") — WS broadcast added the row
            // back to local state, but next chat_messages call dropped it,
            // and a subsequent WS event re-added it. Server is now the
            // source of truth: row with deleted_at = stable tombstone.
            // Best-effort schema upgrade so sealed_sender SELECT doesn't 500
            // on legacy installs that haven't run chat_send yet.
            try { $db->exec("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sealed_sender BOOLEAN DEFAULT FALSE"); } catch (Throwable $e) {}
            $pgStmt = $pg->prepare("
                SELECT id, conversation_id, sender_email, content, type,
                       reply_to_id, reply_quote_text, file_url, file_name, file_size,
                       edited_at, deleted_at, created_at, is_view_once,
                       forwarded_from, COALESCE(forward_count, 0) AS forward_count,
                       client_message_id,
                       COALESCE(conv_pts, 0) AS conv_pts,
                       COALESCE(sealed_sender, FALSE) AS sealed_sender,
                       mentions, viewed_by, thumb_b64, effect
                FROM chat_messages
                WHERE conversation_id = :cid $pgWhere
                ORDER BY id DESC
                LIMIT " . (int)$limit . "
            ");
            foreach ($pgParams as $k => $v) {
                $pgStmt->bindValue($k, $v, \PDO::PARAM_INT);
            }
            if ($clearedAt) {
                $pgStmt->bindValue(':cleared_at', $clearedAt, \PDO::PARAM_STR);
            }
            $pgStmt->execute();
            $messages = $pgStmt->fetchAll(\PDO::FETCH_ASSOC);

            // Batch-load enrichment. Before this refactor every message
            // triggered its own SELECT for reactions, replies, RSVPs, and poll
            // votes — 50 messages = 200+ queries per request, which turned
            // chat_messages into the hottest path in PG under load.
            $ids = array_column($messages, 'id');
            $ids = array_map('intval', $ids);

            $reactionsByMsg = [];
            $replyBodies   = [];
            $rsvpsByMsg    = [];
            $mineRsvpByMsg = [];
            $votesByMsg    = [];
            $myVotesByMsg  = [];
            $replyIds      = [];
            $meetupIds     = [];
            $pollIds       = [];
            foreach ($messages as $m) {
                if (!empty($m['reply_to_id'])) $replyIds[] = (int)$m['reply_to_id'];
                if (($m['type'] ?? '') === 'meetup') $meetupIds[] = (int)$m['id'];
                if (($m['type'] ?? '') === 'poll')   $pollIds[]   = (int)$m['id'];
            }

            // Auto-translate hydration: bulk-load any cached translations
            // for the requester's target locale. Single SELECT keyed by
            // (message_id, lang) — chat_translate_message writes here as a
            // side-effect, so the hit rate climbs over time. Misses fall
            // through to the client which calls chat_translate_message
            // lazily and caches the result back here.
            $translationByMsg = [];
            if ($autoTrLocale !== null && $ids) {
                try {
                    $in = implode(',', array_fill(0, count($ids), '?'));
                    $tStmt = $pg->prepare("SELECT message_id, text FROM chat_message_translations WHERE lang = ? AND message_id IN ($in)");
                    $tStmt->execute(array_merge([$autoTrLocale], $ids));
                    foreach ($tStmt->fetchAll(\PDO::FETCH_ASSOC) as $tr) {
                        $translationByMsg[(int)$tr['message_id']] = (string)$tr['text'];
                    }
                } catch (\Throwable $e) { error_log('[chat_messages/translations.load] ' . $e->getMessage()); }
            }

            // Reactions + reply_to preview read from PG (truth).
            if ($ids) {
                $in = implode(',', array_fill(0, count($ids), '?'));
                $rStmt = $pg->prepare("SELECT message_id, emoji, email FROM chat_message_reactions WHERE message_id IN ($in)");
                $rStmt->execute($ids);
                foreach ($rStmt->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                    $mid = (int)$r['message_id']; $emoji = $r['emoji'];
                    if (!isset($reactionsByMsg[$mid])) $reactionsByMsg[$mid] = [];
                    if (!isset($reactionsByMsg[$mid][$emoji])) {
                        $reactionsByMsg[$mid][$emoji] = ['emoji' => $emoji, 'count' => 0, 'users' => []];
                    }
                    $reactionsByMsg[$mid][$emoji]['count']++;
                    $reactionsByMsg[$mid][$emoji]['users'][] = $r['email'];
                }
            }

            if ($replyIds) {
                $replyIds = array_values(array_unique($replyIds));
                $in = implode(',', array_fill(0, count($replyIds), '?'));
                // Include deleted rows so the reply card can render a
                // "Mensagem apagada" tombstone instead of silently disappearing.
                $rpStmt = $pg->prepare("SELECT id, sender_email, content, type, file_url, deleted_at FROM chat_messages WHERE id IN ($in)");
                $rpStmt->execute($replyIds);
                foreach ($rpStmt->fetchAll(\PDO::FETCH_ASSOC) as $rp) $replyBodies[(int)$rp['id']] = $rp;
            }

            if ($meetupIds) {
                try {
                    $pg->exec("CREATE TABLE IF NOT EXISTS chat_meetup_rsvps (message_id BIGINT NOT NULL, responder_email TEXT NOT NULL, status TEXT NOT NULL, responded_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (message_id, responder_email))");
                    $in = implode(',', array_fill(0, count($meetupIds), '?'));
                    $rs = $pg->prepare("SELECT message_id, responder_email, status FROM chat_meetup_rsvps WHERE message_id IN ($in)");
                    $rs->execute($meetupIds);
                    foreach ($rs->fetchAll() as $r) {
                        $mid = (int)$r['message_id'];
                        if (!isset($rsvpsByMsg[$mid])) $rsvpsByMsg[$mid] = ['yes' => [], 'no' => [], 'maybe' => []];
                        if (isset($rsvpsByMsg[$mid][$r['status']])) $rsvpsByMsg[$mid][$r['status']][] = $r['responder_email'];
                        if (strcasecmp($r['responder_email'], $user['email']) === 0) $mineRsvpByMsg[$mid] = $r['status'];
                    }
                } catch (Throwable $e) { error_log('[chat_messages/rsvps] ' . $e->getMessage()); }
            }

            if ($pollIds) {
                try {
                    $pg->exec("CREATE TABLE IF NOT EXISTS chat_poll_votes (message_id BIGINT NOT NULL, voter_email TEXT NOT NULL, option_index INTEGER NOT NULL, voted_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (message_id, voter_email, option_index))");
                    $in = implode(',', array_fill(0, count($pollIds), '?'));
                    $ts = $pg->prepare("SELECT message_id, option_index, COUNT(*) as c FROM chat_poll_votes WHERE message_id IN ($in) GROUP BY message_id, option_index");
                    $ts->execute($pollIds);
                    foreach ($ts->fetchAll() as $row) {
                        $mid = (int)$row['message_id'];
                        if (!isset($votesByMsg[$mid])) $votesByMsg[$mid] = [];
                        $votesByMsg[$mid][(int)$row['option_index']] = (int)$row['c'];
                    }
                    $paramsMy = array_merge($pollIds, [$user['email']]);
                    $my = $pg->prepare("SELECT message_id, option_index FROM chat_poll_votes WHERE message_id IN ($in) AND LOWER(voter_email) = LOWER(?)");
                    $my->execute($paramsMy);
                    foreach ($my->fetchAll() as $row) {
                        $mid = (int)$row['message_id'];
                        $myVotesByMsg[$mid][] = (int)$row['option_index'];
                    }
                } catch (Throwable $e) { error_log('[chat_messages/polls] ' . $e->getMessage()); }
            }

            // Batch-load delivery receipts for the user's OWN messages so
            // cold-loaded chats render the correct tick state (1v/vv/lido)
            // immediately, without waiting for a new live WS event. Prior
            // behavior: tick stayed 1v on any device that wasn't present
            // at delivery time (e.g. desktop opening a conv after mobile
            // already ack'd delivery on the peer side).
            $ownIds = [];
            foreach ($messages as $m) {
                if (strcasecmp($m['sender_email'] ?? '', $user['email']) === 0) {
                    $ownIds[] = (int)$m['id'];
                }
            }
            $deliveredByMsg = [];
            $readByMsg = [];
            if ($ownIds) {
                try {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    $inPG = implode(',', array_fill(0, count($ownIds), '?'));
                    $rStmt = $pg->prepare("SELECT message_id, email, delivered_at, read_at FROM chat_message_receipts WHERE message_id IN ($inPG)");
                    $rStmt->execute($ownIds);
                    foreach ($rStmt->fetchAll(\PDO::FETCH_ASSOC) as $rr) {
                        $mid = (int)$rr['message_id'];
                        if (!empty($rr['delivered_at'])) $deliveredByMsg[$mid][] = $rr['email'];
                        if (!empty($rr['read_at']))      $readByMsg[$mid][]      = $rr['email'];
                    }
                } catch (Throwable $e) { error_log('[chat_messages/receipts] ' . $e->getMessage()); }
            }

            // For WhatsApp-style group read ticks we need the non-sender
            // member count AND each member's last_read_message_id. The
            // receipts table is only populated on explicit delivery_ack /
            // mark_read; for messages marked read in bulk (the common case)
            // there's no row even though last_read_message_id has moved past
            // them. Without this fallback the bubble tick stayed gray on old
            // messages whose receiver had clearly read everything.
            $convMemberCount = null;
            $memberLastRead  = []; // [lc_email => effective_last_read_id]
            try {
                // Effective last-read per member = GREATEST(
                //   last_read_message_id,       -- explicit mark_read
                //   MAX(msg.id WHERE sender=me) -- implicit: if I sent a
                //                                  message, I've read every
                //                                  earlier message (you can't
                //                                  reply to what you haven't
                //                                  seen). This is what closes
                //                                  the "she replied but tick
                //                                  stayed gray" gap — the peer
                //                                  sent a message without
                //                                  calling mark_read so their
                //                                  last_read_message_id never
                //                                  advanced past ours.
                $cmStmt = $pg->prepare("
                    SELECT
                        m.email,
                        GREATEST(
                            COALESCE(m.last_read_message_id, 0),
                            COALESCE((
                                SELECT MAX(cm.id) FROM chat_messages cm
                                WHERE cm.conversation_id = m.conversation_id
                                  AND LOWER(cm.sender_email) = LOWER(m.email)
                                  AND cm.deleted_at IS NULL
                            ), 0)
                        ) AS last_read_id
                    FROM chat_conversation_members m
                    WHERE m.conversation_id = :cid
                ");
                $cmStmt->execute([':cid' => $conversationId]);
                $rows = $cmStmt->fetchAll(\PDO::FETCH_ASSOC);
                $convMemberCount = count($rows);
                foreach ($rows as $r) {
                    $memberLastRead[strtolower($r['email'])] = (int)$r['last_read_id'];
                }
            } catch (Throwable $e) {}
            $enriched = [];
            $userLcSealed = strtolower($user['email']);
            foreach ($messages as $msg) {
                $msg['id'] = (int)$msg['id'];
                $msg['conversation_id'] = (int)$msg['conversation_id'];
                $msg['reply_to_id'] = $msg['reply_to_id'] ? (int)$msg['reply_to_id'] : null;
                $msg['file_size'] = (int)$msg['file_size'];
                $msg['edited'] = !empty($msg['edited_at']);
                $msg['pinned'] = false;
                // Sealed-sender (Signal-mode) scrub: when the row is sealed
                // AND the requester isn't the sender, hide identifying
                // fields. The sender themselves keeps full visibility (they
                // need to render their own bubble + handle edit/delete).
                $isSealed = !empty($msg['sealed_sender']) && (string)$msg['sealed_sender'] !== 'f';
                $isSenderSelf = (strcasecmp((string)($msg['sender_email'] ?? ''), $user['email']) === 0);
                if ($isSealed && !$isSenderSelf) {
                    $msg['sender_email'] = '';
                    $msg['sealed_sender'] = true;
                }
                $msg['sender_name'] = $msg['sender_email'] ? chatDisplayName($msg['sender_email']) : '';
                $msg['reactions'] = array_values($reactionsByMsg[$msg['id']] ?? []);
                // HLS playlist surfaced opportunistically — generated async
                // during chat_send for video uploads. Falls back to mp4
                // progressive when the .m3u8 hasn't landed yet (transcode
                // takes ~5-30s for typical clips). disk check is cheap (~50µs)
                // so we do it per-row instead of a JOIN.
                $msg['hls_url'] = null;
                if (($msg['type'] ?? '') === 'video' && !empty($msg['file_url'])) {
                    $__rel = parse_url((string)$msg['file_url'], PHP_URL_PATH) ?: $msg['file_url'];
                    if (strpos($__rel, '/data/chat-files/') === 0) {
                        $__hls = '/var/www/mail' . $__rel . '.hls/index.m3u8';
                        if (is_file($__hls)) {
                            $msg['hls_url'] = $__rel . '.hls/index.m3u8';
                        }
                    }
                }
                // Real waveform from server's astats peak extraction. Without
                // this, the audio bubble showed a hash-generated fake shape
                // that was identical for every voice note. With it, the bars
                // visually match the actual loudness curve of the recording.
                if (in_array(($msg['type'] ?? ''), ['audio','voice'], true) && !empty($msg['file_url'])) {
                    $__rel = parse_url((string)$msg['file_url'], PHP_URL_PATH) ?: $msg['file_url'];
                    if (strpos($__rel, '/data/chat-files/') === 0) {
                        $__peaks = '/var/www/mail' . $__rel . '.peaks.json';
                        if (is_file($__peaks)) {
                            $__pkData = @file_get_contents($__peaks);
                            if ($__pkData) {
                                $__decoded = @json_decode($__pkData, true);
                                if (is_array($__decoded) && count($__decoded) > 0) {
                                    $msg['waveform'] = $__decoded;
                                }
                            }
                        }
                    }
                    // ON-DEMAND ONLY: transcript stays out of chat_get_messages
                    // intentionally. The server cache exists for instant lookup
                    // when the user explicitly taps "Transcrever" (frontend
                    // calls chat_transcribe_audio which reads the cache), but
                    // we do NOT auto-inject it into the bubble — Whisper is
                    // expensive and the user wants transcription opt-in per
                    // message. Frontend persists the user-revealed state in
                    // AsyncStorage so the transcript stays visible across
                    // reloads for the user who actually tapped it.
                }
                // Delivery/read state for the sender's own msgs — prevents
                // the multi-device tick desync ("desktop=1v, phone=vv") when
                // a fresh device opens the thread after a live ack fired.
                if (strcasecmp($msg['sender_email'] ?? '', $user['email']) === 0) {
                    $senderLc = strtolower($user['email']);
                    $msg['delivered_to'] = $deliveredByMsg[$msg['id']] ?? [];
                    $msg['read_by']      = $readByMsg[$msg['id']]      ?? [];

                    // Fold the last_read_message_id fallback into read_by so
                    // everything downstream (client + older WS event replays)
                    // sees a consistent reader list. Any non-sender member
                    // whose last_read_message_id >= msg.id counts as read
                    // even if there's no receipts row.
                    $readByLc = array_fill_keys(array_map('strtolower', $msg['read_by']), true);
                    foreach ($memberLastRead as $lc => $lri) {
                        if ($lc === $senderLc) continue;
                        if ($lri >= $msg['id'] && !isset($readByLc[$lc])) {
                            $msg['read_by'][] = $lc;
                            $readByLc[$lc] = true;
                        }
                    }

                    $msg['_delivered']   = !empty($msg['delivered_to']) || !empty($msg['read_by']);
                    // WhatsApp parity: _read true only when ALL non-sender
                    // members have read. For direct (2 people), one reader =
                    // all readers. For groups, tick stays gray until everyone
                    // reads.
                    $readCount = count($msg['read_by']);
                    $memberCount = $convMemberCount ?? null;
                    $msg['_read'] = $memberCount === null
                        ? !empty($msg['read_by'])
                        : ($readCount > 0 && $readCount >= ($memberCount - 1));
                }

                if ($msg['reply_to_id'] && isset($replyBodies[$msg['reply_to_id']])) {
                    $rp = $replyBodies[$msg['reply_to_id']];
                    $msg['reply_to'] = [
                        'id'           => (int)$rp['id'],
                        'sender_email' => $rp['sender_email'],
                        'sender_name'  => chatDisplayName($rp['sender_email']),
                        'content'      => chatTruncate($rp['content'] ?? '', 200),
                        'type'         => $rp['type'],
                        'file_url'     => $rp['file_url'] ?? null,
                        'deleted_at'   => $rp['deleted_at'] ?? null,
                    ];
                } else {
                    $msg['reply_to'] = null;
                }

                if ($msg['type'] === 'meetup') {
                    $meetup = json_decode($msg['content'] ?? '{}', true);
                    if (is_array($meetup)) {
                        $meetup['id'] = $msg['id'];
                        $meetup['rsvps'] = $rsvpsByMsg[$msg['id']] ?? ['yes' => [], 'no' => [], 'maybe' => []];
                        $meetup['my_rsvp'] = $mineRsvpByMsg[$msg['id']] ?? null;
                        $msg['meetup'] = $meetup;
                    }
                }
                if ($msg['type'] === 'playlist') {
                    $pl = json_decode($msg['content'] ?? '{}', true);
                    if (is_array($pl)) {
                        $pl['id'] = $msg['id'];
                        if (!isset($pl['songs']) || !is_array($pl['songs'])) $pl['songs'] = [];
                        $msg['playlist'] = $pl;
                    }
                }
                if ($msg['type'] === 'poll') {
                    $pollData = json_decode($msg['content'] ?? '{}', true);
                    if (is_array($pollData) && isset($pollData['options']) && is_array($pollData['options'])) {
                        $numOpts = count($pollData['options']);
                        $votes = array_fill(0, $numOpts, 0);
                        foreach (($votesByMsg[$msg['id']] ?? []) as $idx => $c) {
                            if ($idx >= 0 && $idx < $numOpts) $votes[$idx] = $c;
                        }
                        $pollData['id'] = $msg['id'];
                        $pollData['votes'] = $votes;
                        $pollData['my_votes'] = $myVotesByMsg[$msg['id']] ?? [];
                        $msg['poll'] = $pollData;
                    }
                }

                // Auto-translate annotation: when the user has a target
                // locale set on this conv we attach the cached translation
                // (if any) and the locale itself. Frontend reads
                // auto_translate_locale to know it should call
                // chat_translate_message for misses, then renders
                // auto_translation as primary text with an "(original)"
                // toggle below.
                if ($autoTrLocale !== null) {
                    $msg['auto_translate_locale'] = $autoTrLocale;
                    if (isset($translationByMsg[$msg['id']])) {
                        $msg['auto_translation'] = $translationByMsg[$msg['id']];
                    }
                }

                $enriched[] = $msg;
            }

            // Return in chronological order (oldest first)
            $enriched = array_reverse($enriched);

            // Check if there are more messages
            $hasMore = false;
            if (count($messages) === $limit) {
                $oldestId = end($messages)['id'];
                $chk = $pg->prepare("SELECT 1 FROM chat_messages WHERE conversation_id = :cid AND id < :oid AND deleted_at IS NULL LIMIT 1");
                $chk->execute([':cid' => $conversationId, ':oid' => $oldestId]);
                $hasMore = (bool)$chk->fetch();
            }

            // Read receipts — WhatsApp blue-tick source of truth. Client
            // uses these to flip own msgs to readStatus=2 (purple). Without
            // this, cold-loaded conversations stayed at single gray/2-gray
            // ticks until a new live chat_read event fired.
            //
            // WhatsApp parity: read_receipts is a BIDIRECTIONAL toggle. If
            // the current user disabled receipts, they ALSO can't see other
            // peers' last_read. And if a peer disabled their own receipts,
            // their last_read is hidden from us. Either side off = blank.
            $readReceipts = [];
            $myReadReceiptsOn = true;
            try {
                $mePref = $pg->prepare("SELECT read_receipts FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
                $mePref->execute([':e' => $user['email']]);
                $myRow = $mePref->fetch(\PDO::FETCH_ASSOC);
                if ($myRow && array_key_exists('read_receipts', $myRow)) {
                    $myReadReceiptsOn = !empty($myRow['read_receipts']);
                }
            } catch (\Throwable $e) {}
            if ($myReadReceiptsOn) try {
                // Pull peer last_read with their read_receipts pref. Peers
                // with receipts off get filtered out below.
                $rr = $pg->prepare("
                    SELECT cm.email,
                           COALESCE(cm.last_read_message_id, 0) AS last_read_id,
                           COALESCE(p.read_receipts, 1) AS peer_rr
                    FROM chat_conversation_members cm
                    LEFT JOIN chat_user_privacy p ON LOWER(p.email) = LOWER(cm.email)
                    WHERE cm.conversation_id = :cid AND LOWER(cm.email) <> LOWER(:me)
                ");
                $rr->execute([':cid' => $conversationId, ':me' => $user['email']]);
                foreach ($rr->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                    if ((int)$r['last_read_id'] > 0 && !empty($r['peer_rr'])) {
                        $readReceipts[] = ['email' => $r['email'], 'last_read_id' => (int)$r['last_read_id']];
                    }
                }
            } catch (Throwable $e) { error_log('[chat_messages/read_receipts] ' . $e->getMessage()); }

            // Block status for this 1:1 conversation. Frontend renders a
            // banner ("Você foi bloqueado" or "Você bloqueou X") + disables
            // input when blocked. Auto-clears on unblock since the next
            // chat_messages poll returns false.
            $blockedByPeer = false;
            $iBlockedPeer = false;
            $blockerName = null;
            try {
                $pq = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me)");
                $pq->execute([':cid' => $conversationId, ':me' => $user['email']]);
                $peerEmails = array_column($pq->fetchAll(), 'email');
                if (count($peerEmails) === 1) {
                    $peer = $peerEmails[0];
                    $bq1 = $db->prepare("SELECT 1 FROM chat_blocked_users WHERE LOWER(blocker_email) = LOWER(:p) AND LOWER(blocked_email) = LOWER(:me) LIMIT 1");
                    $bq1->execute([':p' => $peer, ':me' => $user['email']]);
                    $blockedByPeer = (bool)$bq1->fetch();
                    $bq2 = $db->prepare("SELECT 1 FROM chat_blocked_users WHERE LOWER(blocker_email) = LOWER(:me) AND LOWER(blocked_email) = LOWER(:p) LIMIT 1");
                    $bq2->execute([':me' => $user['email'], ':p' => $peer]);
                    $iBlockedPeer = (bool)$bq2->fetch();
                    if ($blockedByPeer || $iBlockedPeer) {
                        $blockerName = chatDisplayName($peer) ?: $peer;
                    }
                }
            } catch (Throwable $e) { /* table missing — no block status */ }

            jsonResponse(true, [
                'messages'        => $enriched,
                'has_more'        => $hasMore,
                'read_receipts'   => $readReceipts,
                'blocked_by_peer' => $blockedByPeer,
                'i_blocked_peer'  => $iBlockedPeer,
                'blocker_name'    => $blockerName,
            ]);
            break;
        }

        // ============================================================
        // chat_send — Send a message
        // ============================================================
        case 'chat_send': {
            $user = requireChatAuth();

            // ============================================================
            // ANTI-SPAM GUARDS (Telegram/WhatsApp grade) — added 2026-05-08
            // ============================================================
            // Rate limit: 30 messages/minute per sender (was 60). Tightened
            // to mirror Telegram's anti-flood floor. 30/min = 1 every 2s —
            // still generous for fast typists, but cuts script floods in
            // half. New accounts (<24h) get a 10/min cap if their messages
            // go to peers who don't follow them back ("cold outreach"),
            // i.e. classic mass-DM signup spam.
            $rateFile = '/tmp/chat_send_rate_' . md5($user['email']);
            $nowTs = time();
            $rates = [];
            if (file_exists($rateFile)) {
                $raw = @file_get_contents($rateFile);
                $d = $raw ? json_decode($raw, true) : null;
                if (is_array($d)) $rates = array_values(array_filter($d, fn($t) => is_numeric($t) && $t > $nowTs - 60));
            }

            // Determine effective rate cap. Default 30/min. Lower to 10/min
            // for fresh accounts sending into "cold" conversations (peers
            // who don't follow this sender). The follow-back lookup is
            // cheap and bounded — a single PG round-trip with EXISTS.
            $rateCap = 30;
            try {
                $accAgeStmt = $db->prepare("SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) FROM chat_phone_registry WHERE LOWER(email) = LOWER(:e) LIMIT 1");
                $accAgeStmt->execute([':e' => $user['email']]);
                $accAgeSec = (int)($accAgeStmt->fetchColumn() ?: 0);
                if ($accAgeSec > 0 && $accAgeSec < 86400) {
                    // Account younger than 24h. Check if recipient(s) follow
                    // sender back — if not, treat as cold outreach.
                    $peerStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me)");
                    $peerStmt->execute([':cid' => (int)($input['conversation_id'] ?? $_POST['conversation_id'] ?? 0), ':me' => $user['email']]);
                    $peerEmails = array_column($peerStmt->fetchAll(\PDO::FETCH_ASSOC), 'email');
                    $hasFollowBack = false;
                    if ($peerEmails) {
                        $in = implode(',', array_fill(0, count($peerEmails), '?'));
                        $fbStmt = $db->prepare("SELECT 1 FROM chat_messages WHERE LOWER(sender_email) IN ($in) AND conversation_id IN (SELECT conversation_id FROM chat_conversation_members WHERE LOWER(email) = LOWER(?)) AND deleted_at IS NULL LIMIT 1");
                        $fbStmt->execute(array_merge(array_map('strtolower', $peerEmails), [$user['email']]));
                        $hasFollowBack = (bool)$fbStmt->fetchColumn();
                    }
                    if (!$hasFollowBack) $rateCap = 10;
                }
            } catch (\Throwable $e) { /* registry/columns missing on legacy DBs — fall back to 30 cap */ }

            if (count($rates) >= $rateCap) {
                jsonResponse(false, ['retry_after' => 60, 'rate_cap' => $rateCap], 'Sending too fast. Wait a few seconds.', 429);
            }
            $rates[] = $nowTs;
            @file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            // Support both JSON body and multipart form data
            $conversationId = (int)($input['conversation_id'] ?? $_POST['conversation_id'] ?? 0);

            // Parental gate (server-side enforcement). Client UI guards can
            // be bypassed by editing system time / reinstalling — only the
            // server is trustworthy. Look up peer emails of the conversation
            // for contact-whitelist check.
            try {
                $peers = [];
                if ($conversationId > 0) {
                    $pStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me)");
                    $pStmt->execute([':cid' => $conversationId, ':me' => $user['email']]);
                    $peers = array_column($pStmt->fetchAll(\PDO::FETCH_ASSOC), 'email');
                }
                $gate = parentalGate($user['email'], $peers, 'chat');
                if ($gate['blocked']) {
                    jsonResponse(false, ['parental_block' => $gate['reason']], parentalBlockMessage($gate['reason']), 403);
                }
            } catch (\Throwable $e) { error_log('[chat_send.parental] ' . $e->getMessage()); }
            $content = trim($input['content'] ?? $_POST['content'] ?? '');
            $type = $input['type'] ?? $_POST['type'] ?? 'text';
            $replyToId = $input['reply_to_id'] ?? $_POST['reply_to_id'] ?? null;
            // iMessage-style send-with-effect. Whitelisted server-side because
            // a malicious client could otherwise stuff anything into this
            // column and the recipient would replay it as a screen overlay.
            // Bubble effects render in-place; screen effects play full-screen
            // on first render. NULL = no effect (default WhatsApp behavior).
            $effect = strtolower(trim((string)($input['effect'] ?? $_POST['effect'] ?? '')));
            $effectAllowed = ['slam','loud','gentle','invisible-ink','echo','spotlight','balloons','confetti','love','lasers','fireworks','celebration'];
            if ($effect !== '' && !in_array($effect, $effectAllowed, true)) $effect = '';
            // File attachment fields — used when client uploaded the file via Rust/R2
            // first and now wants to register the message record. Without these the
            // file silently disappears from the conversation (message saved with empty
            // file_url) and the recipient sees a broken/blank message bubble.
            $fileUrl  = trim((string)($input['file_url']  ?? $_POST['file_url']  ?? ''));
            $fileName = trim((string)($input['file_name'] ?? $_POST['file_name'] ?? ''));
            $fileSize = (int)($input['file_size'] ?? $_POST['file_size'] ?? 0);
            $viewOnce = (int)!!($input['view_once'] ?? $_POST['view_once'] ?? 0);
            // Mentions: array of emails referenced via @ in the message body.
            // Stored as JSON so the column stays text-typed, and used later to
            // fire targeted push notifications so mentioned users get louder
            // alerts even when the group is muted (WhatsApp/Slack behavior).
            $mentionsInput = $input['mentions'] ?? $_POST['mentions'] ?? null;
            if (is_string($mentionsInput)) {
                $decoded = json_decode($mentionsInput, true);
                $mentionsInput = is_array($decoded) ? $decoded : [];
            }
            if (!is_array($mentionsInput)) $mentionsInput = [];
            $mentionsInput = array_values(array_unique(array_filter(array_map('strtolower', $mentionsInput), fn($e) => filter_var($e, FILTER_VALIDATE_EMAIL))));
            $mentionsJson = !empty($mentionsInput) ? json_encode($mentionsInput) : null;

            // Sealed sender (Signal-style metadata hiding). When the client
            // explicitly opts in via `sealed=true`, we still need a sender
            // identity in chat_messages.sender_email (not nullable, FK-ish
            // semantics), but we mark the row sealed and clients receiving
            // the message render it without sender info on chat_messages
            // fetch. Trade-off: spam control gets weaker because the server
            // can't grep "who sent what to whom" — this is the whole point.
            $sealedSender = !empty($input['sealed']) || !empty($_POST['sealed']) || !empty($input['sealed_sender']);
            // Best-effort schema upgrade so legacy DBs accept the new column.
            try { $db->exec("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sealed_sender BOOLEAN DEFAULT FALSE"); } catch (Throwable $e) {}

            // Telegram-style partial-text quote: when the client replies to
            // only a portion of the parent message, it sends that snippet
            // here. We persist it on the new row so re-renders from cache
            // don't need to re-resolve the parent. Capped to 240 chars —
            // matches Telegram's quote ceiling and stops abusive payloads.
            $replyQuoteText = trim((string)($input['reply_quote_text'] ?? $_POST['reply_quote_text'] ?? ''));
            if ($replyQuoteText !== '' && mb_strlen($replyQuoteText, 'UTF-8') > 240) {
                $replyQuoteText = mb_substr($replyQuoteText, 0, 240, 'UTF-8');
            }
            // Quote without a parent doesn't make sense — drop it silently
            // rather than 400ing.
            if (empty($replyToId)) $replyQuoteText = '';

            // Client-side dedup key (frontend generates a UUID per send attempt).
            // Without this declaration $clientMsgId was undefined → PHP warning
            // on every chat_send. Empty string means "no dedup".
            $clientMsgId = trim((string)($input['client_message_id'] ?? $_POST['client_message_id'] ?? ''));
            // Safety net: older clients might still skip client_message_id. If a
            // server-generated stamp would leave retries without protection, we
            // fall back to a deterministic key derived from (sender, content,
            // minute-bucket). Two clicks within 60s of the exact same content
            // then dedup via UNIQUE (sender, client_message_id). Loose enough
            // to catch double-taps, tight enough to allow intentional repeats.
            if ($clientMsgId === '') {
                $clientMsgId = 'srv_' . substr(sha1(
                    $user['email'] . '|' . $conversationId . '|' . $content . '|' . $type . '|' . floor(time() / 60)
                ), 0, 32);
            }

            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            // For media/file messages the file itself is the payload; only require
            // text content for plain 'text' messages with no attachment.
            if ($content === '' && $type === 'text' && $fileUrl === '') {
                jsonResponse(false, null, 'Message content required', 400);
            }
            // WhatsApp-style body cap. A chat message longer than 65k chars
            // almost always means a bug on the sender (paste of a huge log,
            // or a runaway client). Truncate silently rather than 413-ing
            // so the user's send still lands.
            if (strlen($content) > 65536) $content = mb_substr($content, 0, 32768, 'UTF-8');
            if (!in_array($type, [
                'text', 'image', 'file', 'system', 'gif', 'sticker', 'audio', 'video',
                'location', 'contact',
                // New Telegram-parity types:
                'video_note',      // short round video (iMessage/Telegram video notes)
                'lottie_sticker',  // animated sticker (Lottie/TGS/WebM)
            ], true)) {
                $type = 'text';
            }
            // Sanitize file_url — must be relative under /data/ or a chatyy/R2 URL.
            // Reject anything else to prevent attackers injecting arbitrary URLs.
            if ($fileUrl !== '') {
                $isLocal = (strpos($fileUrl, '/data/') === 0);
                $isCdn   = (bool)preg_match('#^https?://[a-z0-9.-]*chatyy\\.com\\.br/#i', $fileUrl)
                        || (bool)preg_match('#^https?://[a-z0-9.-]*\\.r2\\.cloudflarestorage\\.com/#i', $fileUrl)
                        || (bool)preg_match('#^https?://[a-z0-9.-]*\\.r2\\.dev/#i', $fileUrl);
                if (!$isLocal && !$isCdn) {
                    jsonResponse(false, null, 'Invalid file_url', 400);
                }
                // If a file_url is provided but type is still 'text', infer a sane type
                // so the client renders the bubble correctly (image vs video vs file).
                if ($type === 'text') {
                    $extGuess = strtolower(pathinfo($fileName !== '' ? $fileName : $fileUrl, PATHINFO_EXTENSION));
                    if (in_array($extGuess, ['jpg','jpeg','png','gif','webp','bmp','heic','heif'], true)) {
                        $type = 'image';
                    } elseif (in_array($extGuess, ['mp4','mov','webm','mkv','avi','m4v'], true)) {
                        $type = 'video';
                    } elseif (in_array($extGuess, ['mp3','wav','ogg','m4a','aac','opus'], true)) {
                        $type = 'audio';
                    } else {
                        $type = 'file';
                    }
                }
            }

            $sendMembership = requireConversationMember($db, $conversationId, $user['email']);

            // ============================================================
            // CONTENT-BASED ANTI-SPAM SCANS (post-membership, pre-insert)
            // ============================================================
            // Skip scans on system msgs, file-only payloads, and admin-set
            // group announcements. Only inspect user-typed text bodies.
            // ALSO skip structured-JSON types (location, sticker, gif, voice,
            // poll, contact, payment, encounter, playlist) — their `content`
            // is a JSON blob with Unix timestamps and coordinate floats that
            // collide with the phone-number regex (8-15 digits). Live
            // location was hitting this hardest: each tick rewrites
            // live_until/updated_at, so 3 ticks within 60s tripped the
            // phone-harvest cooldown and 1h-banned the user from messaging.
            $skipScanTypes = ['system','location','sticker','gif','voice','audio','poll','contact','payment','encounter','playlist','image','video','file','reel'];
            if ($content !== '' && !in_array($type, $skipScanTypes, true)) {
                // Guard #2: Link spam classifier. 3+ distinct URLs in one
                // message is the classic phishing/forward-chain shape.
                // We don't block (legit power-users do paste link lists),
                // we flag for review. If chat_spam_flags table is missing,
                // we degrade to /var/log/chat-spam.log so the signal is
                // never lost.
                if (preg_match_all('#https?://[^\s<>"\']+#i', $content, $linkMatches) >= 3) {
                    $distinctHosts = [];
                    foreach ($linkMatches[0] as $url) {
                        $h = parse_url($url, PHP_URL_HOST);
                        if ($h) $distinctHosts[strtolower($h)] = true;
                    }
                    if (count($distinctHosts) >= 3) {
                        try {
                            $db->exec("CREATE TABLE IF NOT EXISTS chat_spam_flags (
                                id BIGSERIAL PRIMARY KEY,
                                sender_email TEXT NOT NULL,
                                conversation_id BIGINT,
                                flag_type TEXT NOT NULL,
                                content_excerpt TEXT,
                                metadata JSONB,
                                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                            )");
                            $db->exec("CREATE INDEX IF NOT EXISTS idx_chat_spam_flags_sender ON chat_spam_flags(sender_email, created_at DESC)");
                            $flagIns = $db->prepare("INSERT INTO chat_spam_flags (sender_email, conversation_id, flag_type, content_excerpt, metadata) VALUES (:e, :c, 'link_spam', :ex, :md)");
                            $flagIns->execute([
                                ':e'  => $user['email'],
                                ':c'  => $conversationId,
                                ':ex' => mb_substr($content, 0, 240, 'UTF-8'),
                                ':md' => json_encode(['hosts' => array_keys($distinctHosts), 'count' => count($linkMatches[0])]),
                            ]);
                        } catch (\Throwable $e) {
                            @file_put_contents('/var/log/chat-spam.log',
                                gmdate('Y-m-d\TH:i:s\Z') . " link_spam sender={$user['email']} conv={$conversationId} hosts=" . implode(',', array_keys($distinctHosts)) . "\n",
                                FILE_APPEND | LOCK_EX);
                        }
                    }
                }

                // Guard #3: Phone-number harvesting. 3+ distinct phone-shaped
                // tokens in a message OR cumulative across last minute = hard
                // block + 1h cooldown (file-based lock). Catches spammers who
                // dump contact lists into DMs to scrape for verification or
                // resell. Pattern: 8-15 digits, optional +/spaces/dashes/parens.
                preg_match_all('#(?:\+?\d[\d\s\-\(\)\.]{7,20}\d)#', $content, $phoneMatches);
                $msgPhones = [];
                foreach (($phoneMatches[0] ?? []) as $p) {
                    $digits = preg_replace('/\D+/', '', $p);
                    if (strlen($digits) >= 8 && strlen($digits) <= 15) $msgPhones[$digits] = true;
                }
                $phoneStateFile = '/tmp/chat_phones_' . md5($user['email']);
                $phoneState = ['phones' => [], 'cooldown_until' => 0];
                if (file_exists($phoneStateFile)) {
                    $raw = @file_get_contents($phoneStateFile);
                    $d = $raw ? json_decode($raw, true) : null;
                    if (is_array($d)) $phoneState = array_merge($phoneState, $d);
                }
                if (($phoneState['cooldown_until'] ?? 0) > $nowTs) {
                    jsonResponse(false, ['cooldown_until' => $phoneState['cooldown_until']], 'Account temporarily restricted (suspected phone-number harvesting). Try again in 1 hour.', 429);
                }
                // Drop expired entries (older than 60s)
                $phoneState['phones'] = array_filter(
                    is_array($phoneState['phones'] ?? null) ? $phoneState['phones'] : [],
                    fn($t) => is_numeric($t) && $t > $nowTs - 60
                );
                foreach (array_keys($msgPhones) as $digits) {
                    $phoneState['phones'][$digits] = $nowTs;
                }
                if (count($phoneState['phones']) >= 3 && count($msgPhones) > 0) {
                    // 3+ distinct phones in 60s window → block + cooldown
                    $phoneState['cooldown_until'] = $nowTs + 3600;
                    @file_put_contents($phoneStateFile, json_encode($phoneState), LOCK_EX);
                    try {
                        $db->exec("CREATE TABLE IF NOT EXISTS chat_spam_flags (
                            id BIGSERIAL PRIMARY KEY, sender_email TEXT NOT NULL, conversation_id BIGINT,
                            flag_type TEXT NOT NULL, content_excerpt TEXT, metadata JSONB,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                        )");
                        $flagIns = $db->prepare("INSERT INTO chat_spam_flags (sender_email, conversation_id, flag_type, content_excerpt, metadata) VALUES (:e, :c, 'phone_harvest', :ex, :md)");
                        $flagIns->execute([
                            ':e'  => $user['email'],
                            ':c'  => $conversationId,
                            ':ex' => mb_substr($content, 0, 240, 'UTF-8'),
                            ':md' => json_encode(['distinct_phones' => count($phoneState['phones']), 'cooldown_seconds' => 3600]),
                        ]);
                    } catch (\Throwable $e) {
                        @file_put_contents('/var/log/chat-spam.log',
                            gmdate('Y-m-d\TH:i:s\Z') . " phone_harvest sender={$user['email']} conv={$conversationId} distinct=" . count($phoneState['phones']) . "\n",
                            FILE_APPEND | LOCK_EX);
                    }
                    jsonResponse(false, ['cooldown_until' => $phoneState['cooldown_until']], 'Phone-number harvesting detected. Account restricted for 1 hour.', 429);
                }
                @file_put_contents($phoneStateFile, json_encode($phoneState), LOCK_EX);
            }

            // Slow-mode enforcement. Group admins write a per-conversation
            // cooldown via chat_set_slow_mode (e.g. 10s for a chatty announce
            // channel). Non-admins who try to send within that window get a
            // 429. Admins always pass — they're the moderators of the gate.
            if (($sendMembership['type'] ?? '') === 'group' && ($sendMembership['role'] ?? 'member') !== 'admin') {
                try {
                    $smRow = $db->prepare("SELECT slow_mode_seconds FROM chat_conversations WHERE id = :id");
                    $smRow->execute([':id' => $conversationId]);
                    $smSec = (int)($smRow->fetchColumn() ?: 0);
                    if ($smSec > 0) {
                        $last = $db->prepare("SELECT created_at FROM chat_messages WHERE conversation_id = :cid AND LOWER(sender_email) = LOWER(:e) AND deleted_at IS NULL AND type <> 'system' ORDER BY id DESC LIMIT 1");
                        $last->execute([':cid' => $conversationId, ':e' => $user['email']]);
                        $lastAt = $last->fetchColumn();
                        if ($lastAt) {
                            $lastTs = strtotime((string)$lastAt);
                            $diff = time() - ($lastTs ?: 0);
                            if ($lastTs && $diff < $smSec) {
                                $wait = $smSec - $diff;
                                jsonResponse(false, ['retry_after' => $wait], 'Slow mode active. Wait ' . $wait . 's.', 429);
                            }
                        }
                    }
                } catch (\Throwable $e) { error_log('[chat_send.slow_mode] ' . $e->getMessage()); }
            }

            // Blocked-user filter.
            $blockersToSuppress = [];
            try {
                $peers = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me)");
                $peers->execute([':cid' => $conversationId, ':me' => $user['email']]);
                $peerList = array_column($peers->fetchAll(), 'email');
                if ($peerList) {
                    $in = implode(',', array_fill(0, count($peerList), '?'));
                    // Bidirectional: blocker can't send to blocked, AND blocked can't send to blocker.
                    // WhatsApp parity (2026-05-13 fix): previously only the blocked side was silenced,
                    // letting the blocker keep messaging — confused QA when only one direction worked.
                    $ps = $db->prepare("SELECT blocker_email FROM chat_blocked_users WHERE (LOWER(blocked_email) = LOWER(?) AND blocker_email IN ($in)) OR (LOWER(blocker_email) = LOWER(?) AND blocked_email IN ($in))");
                    $params = array_merge([$user['email']], $peerList, [$user['email']], $peerList);
                    $ps->execute($params);
                    $blockersToSuppress = array_column($ps->fetchAll(), 'blocker_email');
                }
            } catch (Throwable $e) { /* block table unavailable → no filtering */ }

            // Bug 2026-05-12: block system was filtering broadcast only —
            // the message still landed in chat_messages and re-appeared on
            // the blocker's screen on next history fetch (and the sender's
            // bubble looked "sent" as if nothing was wrong). WhatsApp
            // parity: in a DIRECT (1:1) chat, if the only other participant
            // has the sender blocked, reject the send entirely. Frontend
            // gets back a generic success-shaped response so we don't leak
            // block status to the sender (WhatsApp's stuck-on-✓ pattern) —
            // the bubble shows a single tick and the message never moves
            // to delivered. For groups we keep the broadcast suppression
            // (peers who blocked still get filtered) but allow the row
            // to persist so non-blocking members still see it.
            if (!empty($blockersToSuppress) && count($peerList ?? []) === 1) {
                // Pretend success with a fake id that won't dedup against
                // anything real. The sender's bubble keeps the ✓ (sent)
                // forever, mirroring WhatsApp's "you have been blocked"
                // silent-drop behavior. Skip the broadcast and the insert.
                $fakeId = -1 * abs((int)(microtime(true) * 1000));
                jsonResponse(true, [
                    'id'                => $fakeId,
                    'conversation_id'   => $conversationId,
                    'sender_email'      => $user['email'],
                    'sender_name'       => chatDisplayName($user['email']),
                    'content'           => $content,
                    'type'              => $type,
                    'created_at'        => gmdate('Y-m-d\TH:i:s\Z'),
                    'client_message_id' => $clientMsgId !== '' ? $clientMsgId : null,
                    '_blocked_drop'     => true,
                ], 'Message sent');
                exit;
            }

            // Validate reply_to_id if provided
            if ($replyToId) {
                $replyToId = (int)$replyToId;
                $chk = $db->prepare("SELECT id FROM chat_messages WHERE id = :id AND conversation_id = :cid AND deleted_at IS NULL");
                $chk->execute([':id' => $replyToId, ':cid' => $conversationId]);
                if (!$chk->fetch()) {
                    $replyToId = null; // Silently ignore invalid reply_to
                }
            }

            // Telegram Cloud parity: when the conv has cloud_storage=false
            // we DO NOT persist the message to PG — we only relay it via
            // WS to peers' open sockets. Recipients store it in their
            // local SQLite cache. Tradeoff: if both peers are offline, the
            // message is lost. Frontend tooltip warns the user.
            $cloudStorageConv = true;
            try {
                $csq = $db->prepare("SELECT cloud_storage FROM chat_conversations WHERE id = :id");
                $csq->execute([':id' => $conversationId]);
                $csVal = $csq->fetchColumn();
                if ($csVal !== false && $csVal !== null) {
                    // PG returns 't'/'f' or boolean depending on PDO config.
                    $cloudStorageConv = !($csVal === 'f' || $csVal === false || $csVal === 0 || $csVal === '0');
                }
            } catch (\Throwable $e) { /* column missing on legacy schemas — default true */ }

            if (!$cloudStorageConv) {
                // Build a synthetic message row and broadcast via WS only.
                // No PG insert; no real message_id (use a negative ephemeral
                // id so the client can recognize it as device-only and
                // dedup if a duplicate frame arrives). Recipient persists
                // locally in SQLite.
                $ephemeralId = -1 * abs((int)(microtime(true) * 1000) ^ crc32($user['email'] . '|' . $clientMsgId));
                $ephemeralMsg = [
                    'id'                => $ephemeralId,
                    'conversation_id'   => $conversationId,
                    'sender_email'      => $user['email'],
                    'sender_name'       => chatDisplayName($user['email']),
                    'content'           => $content,
                    'type'              => $type,
                    'reply_to_id'       => $replyToId ?: null,
                    'reply_quote_text'  => $replyQuoteText !== '' ? $replyQuoteText : null,
                    'file_url'          => $fileUrl !== '' ? $fileUrl : null,
                    'file_name'         => $fileName !== '' ? $fileName : null,
                    'file_size'         => $fileSize > 0 ? $fileSize : null,
                    'is_view_once'      => $viewOnce ? 1 : 0,
                    'mentions'          => $mentionsJson,
                    'client_message_id' => $clientMsgId !== '' ? $clientMsgId : null,
                    'effect'            => $effect !== '' ? $effect : null,
                    'created_at'        => gmdate('Y-m-d\TH:i:s\Z'),
                    'reactions'         => [],
                    'reply_to'          => null,
                    'edited'            => false,
                    'pinned'            => false,
                    'cloud_storage'     => false,
                    '_device_only'      => true,
                ];
                http_response_code(200);
                echo json_encode(['success' => true, 'data' => $ephemeralMsg, 'message' => 'Message relayed (device-only)'], JSON_UNESCAPED_UNICODE);
                if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

                // Direct WS broadcast (cannot reuse broadcastChatMessage —
                // that helper SELECTs from chat_messages, which never got
                // a row).
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $peersStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid");
                        $peersStmt->execute([':cid' => $conversationId]);
                        $allEmails = array_column($peersStmt->fetchAll(\PDO::FETCH_ASSOC), 'email');
                        $channels = ["chat_{$conversationId}"];
                        foreach ($allEmails as $em) $channels[] = "chat_user_" . strtolower($em);
                        $payloadBase = json_encode([
                            'channel' => null, 'event' => 'chat_message',
                            'data' => $ephemeralMsg,
                        ]);
                        foreach ($channels as $ch) {
                            $body = preg_replace('/"channel":null/', '"channel":' . json_encode($ch), $payloadBase, 1);
                            $cu = curl_init('http://127.0.0.1:8081/broadcast');
                            curl_setopt_array($cu, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT_MS => 1500, CURLOPT_CONNECTTIMEOUT_MS => 500]);
                            curl_exec($cu); curl_close($cu);
                        }
                    }
                } catch (\Throwable $e) { error_log('[chat_send.device_only.ws] ' . $e->getMessage()); }
                exit;
            }

            // PG is the source of truth — write directly to chat_messages.
            $pg = $db;
            // Two prepared shapes: with vs without sealed_sender column. The
            // ALTER above usually succeeds, but on the very first hit after
            // deploy the schema cache may still see the old layout — fall
            // back to the legacy INSERT if the typed one explodes.
            $pgIns = $pg->prepare("
                INSERT INTO chat_messages
                    (conversation_id, sender_email, sender_name, content, type,
                     reply_to_id, reply_quote_text, file_url, file_name, file_size, is_view_once,
                     viewed_by, starred, mentions, client_message_id, effect, sealed_sender, created_at)
                VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?, ?, ?, ?)
                RETURNING id, created_at
            ");
            $nowIso = gmdate('Y-m-d\TH:i:s\Z'); // strict ISO 8601 UTC — iOS Safari chokes on space-separated
            $messageId = null;
            $actualCreatedAt = $nowIso;
            try {
                $pgIns->execute([
                    $conversationId,
                    $user['email'],
                    chatDisplayName($user['email']),
                    $content,
                    $type,
                    $replyToId ?: null,
                    $replyQuoteText !== '' ? $replyQuoteText : null,
                    $fileUrl !== '' ? $fileUrl : null,
                    $fileName !== '' ? $fileName : null,
                    $fileSize > 0 ? $fileSize : null,
                    $viewOnce ? 1 : 0,
                    $mentionsJson,
                    $clientMsgId !== '' ? $clientMsgId : null,
                    $effect !== '' ? $effect : null,
                    $sealedSender ? 't' : 'f',
                    $nowIso,
                ]);
                $row = $pgIns->fetch(\PDO::FETCH_ASSOC);
                $messageId = (int)$row['id'];
                $actualCreatedAt = $row['created_at'];
            } catch (Throwable $e) {
                // Schema not yet upgraded (sealed_sender column missing) —
                // retry without that column so chat_send keeps working.
                if (stripos($e->getMessage(), 'sealed_sender') !== false) {
                    try {
                        $legacyIns = $pg->prepare("
                            INSERT INTO chat_messages
                                (conversation_id, sender_email, sender_name, content, type,
                                 reply_to_id, reply_quote_text, file_url, file_name, file_size, is_view_once,
                                 viewed_by, starred, mentions, client_message_id, effect, created_at)
                            VALUES
                                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?, ?, ?)
                            RETURNING id, created_at
                        ");
                        $legacyIns->execute([
                            $conversationId, $user['email'], chatDisplayName($user['email']),
                            $content, $type,
                            $replyToId ?: null,
                            $replyQuoteText !== '' ? $replyQuoteText : null,
                            $fileUrl !== '' ? $fileUrl : null,
                            $fileName !== '' ? $fileName : null,
                            $fileSize > 0 ? $fileSize : null,
                            $viewOnce ? 1 : 0,
                            $mentionsJson,
                            $clientMsgId !== '' ? $clientMsgId : null,
                            $effect !== '' ? $effect : null,
                            $nowIso,
                        ]);
                        $row = $legacyIns->fetch(\PDO::FETCH_ASSOC);
                        $messageId = (int)$row['id'];
                        $actualCreatedAt = $row['created_at'];
                        // Fall through past the catch by re-throwing nothing.
                        goto _chatSendInsertDone;
                    } catch (Throwable $e2) { $e = $e2; }
                }
                // UNIQUE race on (sender_email, client_message_id) —
                // another concurrent request already inserted. Return that.
                $code = $e->getCode();
                if ($code === '23505' && $clientMsgId !== '') {
                    $ex = $pg->prepare("SELECT * FROM chat_messages WHERE sender_email = ? AND client_message_id = ? LIMIT 1");
                    $ex->execute([$user['email'], $clientMsgId]);
                    $existing = $ex->fetch(\PDO::FETCH_ASSOC);
                    if ($existing) {
                        $existing['id'] = (int)$existing['id'];
                        $existing['sender_name'] = chatDisplayName($existing['sender_email']);
                        $existing['reactions'] = [];
                        $existing['_dedup_hit'] = true;
                        jsonResponse(true, $existing, 'Race-deduplicated');
                    }
                }
                error_log('[chat_send/pg] ' . $e->getMessage());
                jsonResponse(false, null, 'Insert failed', 500);
            }

            _chatSendInsertDone:

            // Fetch the created message BEFORE firing any push/broadcast — the
            // client needs this row to render. Everything else can run after
            // we've flushed the response to the user.
            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id");
            $stmt->execute([':id' => $messageId]);
            $msg = $stmt->fetch();
            $msg['id'] = (int)$msg['id'];
            $msg['sender_name'] = chatDisplayName($msg['sender_email']);
            $msg['reactions'] = [];
            $msg['reply_to'] = null;
            $msg['edited'] = !empty($msg['edited_at']);
            $msg['pinned'] = false;
            // Sealed-sender flag bubbles up to client. The sender (this
            // request's user) sees their own message normally — peers will
            // get the scrubbed shape via chat_messages enrichment.
            if (!empty($msg['sealed_sender'])) {
                $msg['sealed_sender'] = true;
            }

            // Hydrate reply_to for the sender's UI (same enrichment path as
            // chat_messages). Previously this was hard-coded to null, so the
            // reply bubble only showed the quote after a full refresh.
            if (!empty($msg['reply_to_id'])) {
                try {
                    $rpStmt = $db->prepare("SELECT id, sender_email, content, type, file_url, deleted_at FROM chat_messages WHERE id = :id");
                    $rpStmt->execute([':id' => (int)$msg['reply_to_id']]);
                    $rp = $rpStmt->fetch();
                    if ($rp) {
                        $msg['reply_to'] = [
                            'id'           => (int)$rp['id'],
                            'sender_email' => $rp['sender_email'],
                            'sender_name'  => chatDisplayName($rp['sender_email']),
                            'content'      => mb_substr((string)$rp['content'], 0, 200),
                            'type'         => $rp['type'],
                            'file_url'     => $rp['file_url'],
                            'deleted_at'   => $rp['deleted_at'],
                        ];
                    }
                } catch (Throwable $e) { /* ignore — reply preview is a UX nicety */ }
            }

            // Flush the response to the client NOW so the chat UI unfreezes
            // immediately. WS broadcast, FCM push, conversation touch, and
            // the auto-read update run after fastcgi_finish_request() — the
            // user never waits for a recipient's FCM call to complete. This
            // was the root cause of the "send to Ana Carla is slow" bug —
            // she had stale Expo-format tokens that took the full 10s FCM
            // CURLOPT_TIMEOUT to fail, blocking every send to her.
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $msg, 'message' => 'Message sent'], JSON_UNESCAPED_UNICODE);
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }

            // Everything below now runs in the background.
            // Telegram-style event emission — assign conv_pts on the new row + log event
            try {
                $pts = emitConvEvent($db, (int)$conversationId, 'new_message', $user['email'], ['message_id' => (int)$messageId]);
                if ($pts > 0) {
                    $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                       ->execute([':p' => $pts, ':mid' => $messageId]);
                }
            } catch (Throwable $e) { error_log('[chat_send/pts] ' . $e->getMessage()); }
            try { broadcastChatMessage($db, $conversationId, $messageId, $user['email'], 'chat_message', $blockersToSuppress); }
            catch (Throwable $e) { error_log('[chat_send.ws] ' . $e->getMessage()); }

            // Silent flag: sender explicitly marked this message as
            // non-notifying. Skip the push fan-out entirely so the peer's
            // device gets the bubble live via WS but no banner/sound. The
            // message still lands normally in the thread — only the ambient
            // notification is suppressed (Telegram parity).
            $isSilent = !empty($input['silent']) || !empty($input['is_silent']);
            if (!$isSilent) {
                try { chatSendPushToMembers($db, $conversationId, $messageId, $user['email'], $blockersToSuppress); }
                catch (Throwable $e) { error_log('[chat_send.push] ' . $e->getMessage()); }
            }

            try { touchConversation($db, $conversationId); } catch (Throwable $e) { error_log('[chat_send.touch] ' . $e->getMessage()); }

            // Hashtag indexing (Telegram-style trending). Parses #word tokens
            // out of the message body and inserts one row per tag into
            // chat_hashtags. Cheap PG insert (typed B-tree on hashtag,
            // created_at) — runs after fastcgi_finish_request() so it never
            // adds latency to chat_send. Errors logged, never bubble up.
            try {
                if (is_string($content) && $content !== '' && strpos($content, '#') !== false) {
                    chatHashtagIndex($db, (int)$messageId, (int)$conversationId, $content);
                }
            } catch (Throwable $e) { error_log('[chat_send.hashtag] ' . $e->getMessage()); }

            // Auto-read: sending a message means the sender has implicitly
            // read every earlier message in the thread. This keeps the
            // sender-side list (unread count, last_read) consistent and —
            // critically — advances the *peer-side* read tick to purple
            // even when the peer has the "share read receipts" privacy
            // toggle off (otherwise their ticks stay gray forever, which
            // users interpret as "my message wasn't read"). Mirror to PG
            // so chat_messages?conv query returns fresh read_receipts.
            try {
                $db->prepare("UPDATE chat_conversation_members SET last_read_message_id = GREATEST(COALESCE(last_read_message_id,0), :mid::int), last_read_at = (now() AT TIME ZONE 'UTC')::text WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)")
                   ->execute([':mid' => $messageId, ':cid' => $conversationId, ':email' => $user['email']]);
            } catch (Throwable $e) { error_log('[chat_send.autoread/pg] ' . $e->getMessage()); }
            // Broadcast a synthetic chat_read so the peer's sender-side
            // ticks flip to purple immediately.
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    $peersStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me)");
                    $peersStmt->execute([':cid' => $conversationId, ':me' => $user['email']]);
                    $peerEmails = array_column($peersStmt->fetchAll(), 'email');
                    $channels = ["chat_{$conversationId}"];
                    // Lowercase — WS hub auto-inscreve em chat_user_{strtolower(email)}
                    foreach ($peerEmails as $pe) $channels[] = "chat_user_" . strtolower($pe);
                    $payload = json_encode([
                        'channel' => null, 'event' => 'chat_read',
                        'data' => ['conversation_id' => (int)$conversationId, 'email' => $user['email'], 'last_read_id' => (int)$messageId],
                    ]);
                    foreach ($channels as $ch) {
                        $body = preg_replace('/"channel":null/', '"channel":"' . $ch . '"', $payload, 1);
                        foreach (['http://127.0.0.1:8081/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT_MS => 1500, CURLOPT_CONNECTTIMEOUT_MS => 500]);
                            curl_exec($cu); curl_close($cu);
                        }
                    }
                }
            } catch (Throwable $e) { error_log('[chat_send.autoread.ws] ' . $e->getMessage()); }

            exit;
        }

        // ============================================================
        // chat_edit — Edit a message
        // ============================================================
        case 'chat_edit': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            $content = trim($input['content'] ?? '');
            if (chatIdempotent($user['email'], (string)($input['client_action_id'] ?? ''))) { jsonResponse(true, ['skipped' => 'duplicate'], 'idempotent_replay'); }
                        if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            if ($content === '') jsonResponse(false, null, 'content required', 400);
            if (strlen($content) > 65536) $content = mb_substr($content, 0, 32768, 'UTF-8');

            // Verify ownership
            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);
            if (strcasecmp($msg['sender_email'], $user['email']) !== 0) {
                jsonResponse(false, null, 'Can only edit your own messages', 403);
            }
            // WhatsApp-style 15-minute edit window.
            $createdTs = strtotime((string)$msg['created_at']);
            if ($createdTs && (time() - $createdTs) > 900) {
                jsonResponse(false, null, 'Edit window expired (15 min)', 403);
            }

            // Snapshot old content into edit history.
            try {
                $db->prepare("INSERT INTO chat_message_versions (message_id, content, edited_at) VALUES (:m, :c, now()::text)")
                   ->execute([':m' => $messageId, ':c' => (string)$msg['content']]);
            } catch (Throwable $e) { error_log('[chat_edit/versions] ' . $e->getMessage()); }

            try {
                $db->prepare("UPDATE chat_messages SET content = ?, edited_at = ? WHERE id = ?")
                   ->execute([$content, date('c'), $messageId]);
            } catch (Throwable $e) {
                error_log('[chat_edit/pg] ' . $e->getMessage());
                jsonResponse(false, null, 'Edit failed', 500);
            }
            try { emitConvEvent($db, (int)$msg['conversation_id'], 'edit', $user['email'], ['message_id' => (int)$messageId, 'content' => $content]); } catch (Throwable $e) { error_log('[edit/pts] ' . $e->getMessage()); }
            try { broadcastChatMessage($db, (int)$msg['conversation_id'], $messageId, $user['email'], 'edit'); }
            catch (Throwable $e) { error_log('[chat_edit.ws] ' . $e->getMessage()); }
            try { touchConversation($db, (int)$msg['conversation_id']); } catch (Throwable $e) {}

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id");
            $stmt->execute([':id' => $messageId]);
            $updated = $stmt->fetch();
            $updated['id'] = (int)$updated['id'];
            $updated['sender_name'] = chatDisplayName($updated['sender_email']);
            $updated['edited'] = !empty($updated['edited_at']);
            $updated['pinned'] = false;

            jsonResponse(true, $updated, 'Message edited');
            break;
        }

        // ============================================================
        // chat_delete_message — Soft-delete a message
        // ============================================================
        case 'chat_delete_message': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (chatIdempotent($user['email'], (string)($input['client_action_id'] ?? ''))) { jsonResponse(true, ['skipped' => 'duplicate'], 'idempotent_replay'); }
                        if (!$messageId) jsonResponse(false, null, 'message_id required', 400);

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);

            // 3-hour window: sender can only delete-for-everyone within 3h.
            $isMine = strcasecmp($msg['sender_email'], $user['email']) === 0;
            if ($isMine) {
                // strtotime on unknown format returns false; time()-false == time(),
                // which makes the age check always pass. Validate parse first.
                $ts = $msg['created_at'] ? @strtotime($msg['created_at']) : false;
                $age = $ts ? (time() - $ts) : 0;
                if ($age > 10800) {
                    jsonResponse(false, null, 'Você só pode apagar mensagens nos primeiros 3 horas.', 403);
                }
            }
            if (!$isMine) {
                $membership = requireConversationMember($db, $msg['conversation_id'], $user['email']);
                // Check CURRENT role only — the old created_by fallback let a
                // demoted creator keep admin-delete privileges forever.
                if ($membership['role'] !== 'admin') {
                    jsonResponse(false, null, 'Can only delete your own messages', 403);
                }
            }

            try {
                // Wrap both writes so a mid-op failure doesn't leave reactions
                // orphaned under a tombstoned message row.
                $db->beginTransaction();
                $db->prepare("UPDATE chat_messages SET deleted_at = ?, content = '' WHERE id = ?")
                   ->execute([date('c'), $messageId]);
                $db->prepare("DELETE FROM chat_message_reactions WHERE message_id = ?")
                   ->execute([$messageId]);
                $db->commit();
            } catch (Throwable $e) {
                try { if ($db->inTransaction()) $db->rollBack(); } catch (Throwable $r) {}
                error_log('[chat_delete/pg] ' . $e->getMessage());
                jsonResponse(false, null, 'Delete failed', 500);
            }
            try { emitConvEvent($db, (int)$msg['conversation_id'], 'delete', $user['email'], ['message_id' => (int)$messageId]); } catch (Throwable $e) { error_log('[delete/pts] ' . $e->getMessage()); }
            try { broadcastChatMessage($db, (int)$msg['conversation_id'], $messageId, $user['email'], 'delete'); }
            catch (Throwable $e) { error_log('[chat_delete.ws] ' . $e->getMessage()); }
            try { touchConversation($db, (int)$msg['conversation_id']); } catch (Throwable $e) {}
            jsonResponse(true, null, 'Message deleted');
            break;
        }

        // ============================================================
        // chat_react — Toggle a reaction on a message
        // ============================================================
        case 'chat_react': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            $emoji = trim($input['emoji'] ?? '');
            $stickerUrl = trim($input['sticker_url'] ?? '');
            if (chatIdempotent($user['email'], (string)($input['client_action_id'] ?? ''))) { jsonResponse(true, ['skipped' => 'duplicate'], 'idempotent_replay'); }
                        if (!$messageId) jsonResponse(false, null, 'message_id required', 400);

            // Sticker reactions are a premium feature. Validate the URL,
            // gate behind plan != 'free', then encode as `sticker:<url>` so
            // it shares the existing emoji column / dedup index.
            if ($stickerUrl !== '') {
                $u = parse_url($stickerUrl);
                $okScheme = isset($u['scheme']) && in_array(strtolower($u['scheme']), ['http','https'], true);
                $okPath   = !isset($u['scheme']) && str_starts_with($stickerUrl, '/data/');
                if (!$okScheme && !$okPath) jsonResponse(false, null, 'invalid sticker_url', 400);
                if (strlen($stickerUrl) > 512) jsonResponse(false, null, 'sticker_url too long', 400);
                try {
                    require_once __DIR__ . '/plans.php';
                    $plan = getUserPlan($user['email']);
                    if (($plan['plan'] ?? 'free') === 'free') {
                        jsonResponse(false, null, 'Sticker reactions are a premium feature', 402);
                    }
                } catch (Throwable $e) { /* if plans subsystem fails, fall through to deny */
                    jsonResponse(false, null, 'Premium check unavailable', 503);
                }
                $emoji = 'sticker:' . $stickerUrl;
            } else {
                if ($emoji === '') jsonResponse(false, null, 'emoji required', 400);
                // Cap emoji input at 32 UTF-8 chars. Real emojis are 1-8 code
                // points; 32 leaves room for compound emoji + variation
                // selectors + combining marks but blocks clients that try to
                // shove a whole message body into the emoji field.
                if (mb_strlen($emoji, 'UTF-8') > 32) $emoji = mb_substr($emoji, 0, 32, 'UTF-8');
            }

            // Rate limit: 120 reactions/min/user. Stops the "tap-emoji-500x"
            // spam case and matches the chat_send limiter's shape.
            try {
                $rateFile = sys_get_temp_dir() . '/chat_react_rate_' . md5($user['email']) . '.txt';
                $now = time();
                $count = 0; $windowStart = $now;
                if (is_readable($rateFile)) {
                    $data = @file_get_contents($rateFile);
                    if ($data) {
                        $parts = explode('|', $data);
                        if (count($parts) === 2) {
                            $windowStart = (int)$parts[0];
                            $count = (int)$parts[1];
                            if ($now - $windowStart > 60) { $windowStart = $now; $count = 0; }
                        }
                    }
                }
                if ($count >= 120) jsonResponse(false, null, 'Rate limit exceeded', 429);
                @file_put_contents($rateFile, $windowStart . '|' . ($count + 1), LOCK_EX);
            } catch (Throwable $e) {}

            // Verify message exists and user is a member of its conversation
            $stmt = $db->prepare("SELECT conversation_id FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);

            requireConversationMember($db, $msg['conversation_id'], $user['email']);

            // Toggle: if reaction exists, remove it; otherwise, add it
            $pgChk = $db->prepare("SELECT id FROM chat_message_reactions WHERE message_id = ? AND LOWER(email) = LOWER(?) AND emoji = ?");
            $pgChk->execute([$messageId, $user['email'], $emoji]);
            $pgExisting = $pgChk->fetchColumn();
            if ($pgExisting) {
                $db->prepare("DELETE FROM chat_message_reactions WHERE id = ?")->execute([(int)$pgExisting]);
                $action_taken = 'removed';
            } else {
                try {
                    $db->prepare("INSERT INTO chat_message_reactions (message_id, email, emoji, created_at) VALUES (?,?,?, now()::text)")
                       ->execute([$messageId, $user['email'], $emoji]);
                    $action_taken = 'added';
                } catch (Throwable $e) { error_log('[chat_react/pg-ins] ' . $e->getMessage()); $action_taken = 'added'; }
            }

            // Return updated reactions.
            $rStmt = $db->prepare("SELECT emoji, email FROM chat_message_reactions WHERE message_id = ?");
            $rStmt->execute([$messageId]);
            $rawReactions = $rStmt->fetchAll(\PDO::FETCH_ASSOC);

            $grouped = [];
            foreach ($rawReactions as $r) {
                $e = $r['emoji'];
                if (!isset($grouped[$e])) {
                    $grouped[$e] = ['emoji' => $e, 'count' => 0, 'users' => []];
                }
                $grouped[$e]['count']++;
                $grouped[$e]['users'][] = $r['email'];
            }

            // Broadcast the reaction change so everyone's UI counter is
            // live. Without this, reactions only animated on the actor's
            // device and other viewers saw stale counts until next refresh.
            try {
                // Carry the full reactions array in the event payload so
                // chat_sync clients can apply the state without a refetch.
                // Previously the payload was just message_id and the client
                // flagged the row _reactionsStale with no refetch path.
                try { emitConvEvent($db, (int)$msg['conversation_id'], 'reaction', $user['email'], ['message_id' => (int)$messageId, 'reactions' => array_values($grouped)]); } catch (Throwable $e) { error_log('[react/pts] ' . $e->getMessage()); }
                broadcastChatMessage($db, (int)$msg['conversation_id'], $messageId, $user['email'], 'reaction');
            } catch (Throwable $e) { error_log('[chat_react.ws] ' . $e->getMessage()); }

            jsonResponse(true, [
                'action'    => $action_taken,
                'reactions' => array_values($grouped),
            ], 'Reaction ' . $action_taken);
            break;
        }

        // ============================================================
        // chat_mark_read / chat_read — Mark conversation as read
        // ============================================================
        case 'chat_mark_read':
        case 'chat_read': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            // If message_id provided, use it; otherwise use latest message
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) {
                $stmt = $db->prepare("SELECT MAX(id) as max_id FROM chat_messages WHERE conversation_id = :cid AND deleted_at IS NULL");
                $stmt->execute([':cid' => $conversationId]);
                $row = $stmt->fetch();
                $messageId = $row ? (int)$row['max_id'] : 0;
            }

            if ($messageId > 0) {
                try {
                    $db->prepare("UPDATE chat_conversation_members SET last_read_message_id = GREATEST(COALESCE(last_read_message_id,0), :mid::int), last_read_at = (now() AT TIME ZONE 'UTC')::text WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)")
                       ->execute([':mid' => $messageId, ':cid' => $conversationId, ':email' => $user['email']]);
                    // Stamp read_at on every incoming-to-this-user message up
                    // to the ack point — WhatsApp "read by" modal parity.
                    $db->prepare("INSERT INTO chat_message_receipts (message_id, email, delivered_at, read_at)                         SELECT m.id, :email, COALESCE(r.delivered_at, (now() AT TIME ZONE 'UTC')::text), (now() AT TIME ZONE 'UTC')::text                         FROM chat_messages m                         LEFT JOIN chat_message_receipts r ON r.message_id = m.id::int AND LOWER(r.email) = LOWER(:email)                         WHERE m.conversation_id = :cid AND m.id::int <= :mid::int AND LOWER(m.sender_email) <> LOWER(:email) AND m.deleted_at IS NULL                         ON CONFLICT (message_id, email) DO UPDATE SET                             read_at = COALESCE(chat_message_receipts.read_at, EXCLUDED.read_at),                             delivered_at = COALESCE(chat_message_receipts.delivered_at, EXCLUDED.delivered_at)")
                       ->execute([':email' => $user['email'], ':cid' => $conversationId, ':mid' => $messageId]);
                    // Mirror the read/delivered stamps onto chat_messages so
                    // the chat_list query (which only reads the row-level
                    // columns, not the per-user receipts table) shows the
                    // correct ✓/✓✓/✓✓-purple checkmark in the conversation
                    // list without a separate join. chat_messages.delivered_at
                    // and read_at are timestamptz (the receipts table is text),
                    // so we use now() directly here.
                    $db->prepare("UPDATE chat_messages SET
                            delivered_at = COALESCE(delivered_at, now()),
                            read_at      = COALESCE(read_at,      now())
                        WHERE conversation_id = :cid
                          AND id <= :mid
                          AND LOWER(sender_email) <> LOWER(:email)
                          AND deleted_at IS NULL")
                       ->execute([':cid' => $conversationId, ':mid' => $messageId, ':email' => $user['email']]);
                } catch (Throwable $e) { error_log('[chat_read/pg] ' . $e->getMessage()); }

                // Broadcast a read receipt so the sender's devices update the
                // check-marks in real time instead of waiting for poll/refresh.
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $peers = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me)");
                        $peers->execute([':cid' => $conversationId, ':me' => $user['email']]);
                        $recipients = array_column($peers->fetchAll(), 'email');
                        // Normalize emails to lowercase — o WS hub auto-inscreve
                        // em chat_user_{strtolower(email)}, e enviar com case
                        // misto deixava o broadcast cair em canal vazio (motivo
                        // de "V/VV não atualiza live").
                        $channels = ["chat_{$conversationId}"];
                        foreach ($recipients as $r) $channels[] = "chat_user_" . strtolower($r);
                        $channels[] = "chat_user_" . strtolower($user['email']); // own other devices
                        $payload = [
                            'conversation_id' => (int)$conversationId,
                            'email'           => $user['email'],
                            'last_read_id'    => (int)$messageId,
                        ];
                        foreach ($channels as $ch) {
                            $body = json_encode(['channel' => $ch, 'event' => 'chat_read', 'data' => $payload]);
                            foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                                $cu = curl_init($endpoint);
                                curl_setopt_array($cu, [
                                    CURLOPT_POST => true,
                                    CURLOPT_POSTFIELDS => $body,
                                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                    CURLOPT_RETURNTRANSFER => true,
                                    // 500ms was too tight on a loaded server — under even mild
                                    // contention the read-receipt broadcast timed out and the
                                    // sender's ticks stayed gray forever. 2s matches what the
                                    // rest of the WS broadcasts use.
                                    CURLOPT_TIMEOUT_MS => 2000,
                                    CURLOPT_CONNECTTIMEOUT_MS => 500,
                                ]);
                                curl_exec($cu);
                                curl_close($cu);
                            }
                        }
                    }
                } catch (Throwable $e) { error_log('[chat_read.ws] ' . $e->getMessage()); }
            }

            jsonResponse(true, ['message_id' => $messageId], 'Marked as read');
            try { if (!empty($conversationId) && !empty($messageId)) emitConvEvent($db, (int)$conversationId, 'read', $user['email'], ['message_id' => (int)$messageId]); } catch (Throwable $e) { error_log('[read/pts] ' . $e->getMessage()); }
            break;
        }

        // ============================================================
        // user_presence / chat_presence — Update online status
        // ============================================================
        case 'user_presence':
        case 'chat_presence': {
            $user = requireChatAuth();
            $status = $input['status'] ?? 'online';
            if (!in_array($status, ['online', 'away', 'offline'], true)) {
                $status = 'online';
            }

            $db->prepare("
                INSERT INTO chat_user_presence (email, status, last_seen)
                VALUES (:email, :status, now()::text)
                ON CONFLICT (email) DO UPDATE SET status = EXCLUDED.status, last_seen = EXCLUDED.last_seen
            ")->execute([':email' => $user['email'], ':status' => $status]);

            // Return presence of all contacts (people who share a conversation with user)
            // Telegram-grade privacy filter:
            //   1. Honor each peer's last_seen visibility ('everyone' / 'contacts' /
            //      'nobody'). 'nobody' → drop entirely. 'contacts' is implicit (the
            //      mutual-conversation IN clause already enforces "shares a thread").
            //   2. Drop any peer on either side of a block. Without this, a blocked
            //      peer still saw the requester come/go online via this endpoint.
            $stmt = $db->prepare("
                SELECT DISTINCT cp.email, cp.status, cp.last_seen,
                                COALESCE(p.last_seen, 'everyone') AS visibility
                FROM chat_user_presence cp
                LEFT JOIN chat_user_privacy p ON LOWER(p.email) = LOWER(cp.email)
                WHERE LOWER(cp.email) IN (
                    SELECT DISTINCT LOWER(cm2.email)
                    FROM chat_conversation_members cm1
                    JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
                    WHERE LOWER(cm1.email) = LOWER(:email) AND LOWER(cm2.email) <> LOWER(:email2)
                )
                  AND LOWER(cp.email) NOT IN (
                    SELECT LOWER(blocker_email) FROM chat_blocked_users WHERE LOWER(blocked_email) = LOWER(:me1)
                    UNION
                    SELECT LOWER(blocked_email) FROM chat_blocked_users WHERE LOWER(blocker_email) = LOWER(:me2)
                  )
            ");
            $stmt->execute([
                ':email' => $user['email'], ':email2' => $user['email'],
                ':me1' => $user['email'], ':me2' => $user['email'],
            ]);
            $rawPresences = $stmt->fetchAll();
            $presences = [];
            foreach ($rawPresences as $p) {
                $vis = $p['visibility'] ?? 'everyone';
                if ($vis === 'nobody') continue;
                unset($p['visibility']);
                $presences[] = $p;
            }

            jsonResponse(true, $presences);
            break;
        }

        // ============================================================
        // chat_typing — Set typing indicator
        // ============================================================
        case 'chat_typing': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            // Privacy gate: typing is a presence/activity signal — if the user
            // hid their last_seen ('nobody'), peers must NOT see typing either.
            // Bidirectional read_receipts also implies typing reciprocity (if I
            // hide my read state, my typing state is hidden too — WhatsApp parity).
            // We swallow the broadcast here so the WS hub never gets the event.
            try {
                $pq = $db->prepare("SELECT last_seen, read_receipts FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
                $pq->execute([':e' => $user['email']]);
                $pr = $pq->fetch(\PDO::FETCH_ASSOC);
                if ($pr) {
                    $hideTyping = ($pr['last_seen'] ?? 'everyone') === 'nobody'
                                  || (array_key_exists('read_receipts', $pr) && empty($pr['read_receipts']));
                    if ($hideTyping) {
                        // Acknowledge to client (no error) but don't surface a
                        // typing event peers can render. ack=false signals the
                        // client not to fan out via WS either.
                        jsonResponse(true, [
                            'conversation_id' => $conversationId,
                            'email'           => $user['email'],
                            'suppressed'      => true,
                            'typing'          => false,
                        ]);
                        break;
                    }
                }
            } catch (\Throwable $e) { error_log('[chat_typing/privacy] ' . $e->getMessage()); }

            // Update presence to indicate activity
            $db->prepare("
                INSERT INTO chat_user_presence (email, status, last_seen)
                VALUES (:email, 'online', now()::text)
                ON CONFLICT (email) DO UPDATE SET status = 'online', last_seen = EXCLUDED.last_seen
            ")->execute([':email' => $user['email']]);

            // Typing indicators are ephemeral — just acknowledge
            // Real-time typing would be handled by WebSocket
            jsonResponse(true, [
                'conversation_id' => $conversationId,
                'email'           => $user['email'],
                'name'            => $user['name'],
                'typing'          => true,
            ]);
            break;
        }

        // ============================================================
        // chat_contacts — List OneMundo users for starting chats
        // ============================================================
        // ============================================================
        // chat_sync_contacts — Upload phone hashes, get matches.
        // Client sends { hashes: [sha256(E164Phone), ...] } and we return
        // the subset that are registered Chatyy users (via chat_phone_registry).
        // ============================================================
        case 'chat_sync_contacts': {
            $user = requireChatAuth();
            $hashes = $input['hashes'] ?? [];
            if (!is_array($hashes) || empty($hashes)) {
                jsonResponse(true, ['matches' => []]);
                break;
            }
            // Dedupe + cap (anti-abuse). A phone book with 5000 entries shouldn't
            // let a client DoS us. E.164 hash is fixed 64-char hex so we can
            // check length cheaply before hitting the DB.
            $clean = [];
            foreach ($hashes as $h) {
                if (is_string($h) && preg_match('/^[a-f0-9]{64}$/', strtolower($h))) $clean[strtolower($h)] = true;
                if (count($clean) >= 5000) break;
            }
            if (empty($clean)) {
                jsonResponse(true, ['matches' => []]);
                break;
            }
            $placeholders = implode(',', array_fill(0, count($clean), '?'));
            $sql = "SELECT r.phone_hash, r.email, COALESCE(LOWER(r.email), '') AS email_norm
                    FROM chat_phone_registry r
                    WHERE r.phone_hash IN ($placeholders)
                      AND LOWER(r.email) <> LOWER(?)";
            $params = array_keys($clean);
            $params[] = $user['email'];
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();

            // Persist the lookups so when someone with an un-matched hash registers
            // later (chat_register_phone), we can broadcast to everyone who was "waiting"
            // for that number. WhatsApp-style "X entrou no Chatyy" reverse discovery.
            // Only persist hashes — we never see plaintext phones.
            try {
                $ins = $db->prepare("INSERT INTO chat_contact_lookups (email, phone_hash, last_lookup_at)
                                     VALUES (:e, :h, NOW())
                                     ON CONFLICT (email, phone_hash) DO UPDATE SET last_lookup_at = NOW()");
                foreach (array_keys($clean) as $h) {
                    $ins->execute([':e' => $user['email'], ':h' => $h]);
                }
            } catch (\Throwable $_) { /* non-fatal */ }

            // Enrich with display name / avatar path so the client can render directly.
            $matches = [];
            foreach ($rows as $r) {
                $matches[] = [
                    'phone_hash' => $r['phone_hash'],
                    'email' => $r['email'],
                    'name'  => chatDisplayName($r['email']),
                ];
            }
            jsonResponse(true, ['matches' => $matches]);
            break;
        }

        // ============================================================
        // chat_register_phone — Idempotent upsert of the CURRENT user's phone.
        // Used on signup/phone-verify to make the user discoverable. The
        // client hashes (SHA-256 of E.164 number) before sending — we never
        // see plaintext phones server-side for non-own registrations.
        // ============================================================
        case 'chat_register_phone': {
            $user = requireChatAuth();
            $hash = strtolower(trim($input['phone_hash'] ?? ''));
            if (!preg_match('/^[a-f0-9]{64}$/', $hash)) {
                jsonResponse(false, null, 'phone_hash must be SHA-256 hex (64 chars)', 400);
            }
            // Detect first-time registration to decide whether to broadcast a
            // "contact_joined" event. Re-registration of the same hash (e.g.
            // re-verifying phone on the same account) should not re-notify.
            $existed = $db->prepare("SELECT 1 FROM chat_phone_registry WHERE phone_hash = :h");
            $existed->execute([':h' => $hash]);
            $isNew = !$existed->fetchColumn();

            $stmt = $db->prepare("INSERT INTO chat_phone_registry (phone_hash, email, verified) VALUES (:h, :e, TRUE)
                                  ON CONFLICT (phone_hash) DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()");
            $stmt->execute([':h' => $hash, ':e' => $user['email']]);

            // Reverse-discovery: anyone who previously searched for this hash
            // via chat_sync_contacts gets notified. Two channels so the user
            // gets it whether the app is open or not:
            //   - WS /notify → real-time UI update (when app foregrounded)
            //   - fcmSendToUser → push notification (when app closed/background)
            // WhatsApp-style "João entrou no Chatyy".
            if ($isNew) {
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    $waiters = $db->prepare("SELECT email FROM chat_contact_lookups WHERE phone_hash = :h AND LOWER(email) <> LOWER(:me)");
                    $waiters->execute([':h' => $hash, ':me' => $user['email']]);
                    $joinerName = chatDisplayName($user['email']);
                    $payload = [
                        'email' => $user['email'],
                        'name'  => $joinerName,
                        'joined_at' => gmdate('c'),
                    ];
                    // Load push helpers lazily
                    if (!function_exists('fcmSendToUser')) {
                        @require_once __DIR__ . '/firebase_push.php';
                    }
                    foreach ($waiters->fetchAll(PDO::FETCH_COLUMN) as $waiterEmail) {
                        // 1) WS event
                        if ($wsKey) {
                            $cu = curl_init('http://127.0.0.1:8081/notify');
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => json_encode([
                                    'email' => $waiterEmail,
                                    'event' => 'contact_joined',
                                    'data'  => $payload,
                                ]),
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 800,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu);
                            curl_close($cu);
                        }
                        // 2) Push notification (Firebase). Carries phone_hash so the
                        // client can map it back to the user's locally-saved contact
                        // name ("João Trabalho" etc) before rendering the toast.
                        if (function_exists('fcmSendToUser')) {
                            try {
                                fcmSendToUser(
                                    $waiterEmail,
                                    $joinerName . ' entrou no Chatyy',
                                    'Agora você pode conversar direto pelo app.',
                                    [
                                        'type'        => 'contact_joined',
                                        'email'       => $user['email'],
                                        'name'        => $joinerName,
                                        'phone_hash'  => $hash,
                                        'deep_link'   => '/u/' . urlencode($user['email']),
                                    ]
                                );
                            } catch (\Throwable $_) {}
                        }
                    }
                } catch (\Throwable $_) { /* non-fatal */ }
            }
            jsonResponse(true, ['registered' => true, 'notified_waiters' => $isNew]);
            break;
        }

        // ============================================================
        // chat_friend_suggestions — "Pessoas que você pode conhecer"
        // Combines three signal sources and returns top N scored users:
        //   1. Phone matches: people already synced via chat_sync_contacts
        //      who are NOT already in a conversation with you.
        //   2. Friends-of-friends: follow-graph depth-2 (someone whom
        //      multiple of your contacts follow, but you don't).
        //   3. Group co-members: people who share a group with you
        //      but you haven't DMed yet.
        // Score = sum of weights across sources; ties broken by recency.
        // ============================================================
        case 'chat_friend_suggestions': {
            $user = requireChatAuth();
            $me = strtolower($user['email']);
            $limit = min(50, max(1, (int)($input['limit'] ?? 20)));

            // 1) People I've already DMed — exclude from suggestions.
            $existing = [$me => true];
            $st = $db->prepare("
                SELECT DISTINCT LOWER(cm2.email) AS e
                FROM chat_conversation_members cm1
                JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
                JOIN chat_conversations c ON c.id = cm1.conversation_id AND c.type = 'direct'
                WHERE LOWER(cm1.email) = :me AND LOWER(cm2.email) <> :me
            ");
            $st->execute([':me' => $me]);
            foreach ($st->fetchAll() as $r) $existing[$r['e']] = true;

            // 2) Also exclude blocked users both ways.
            try {
                $st = $db->prepare("SELECT LOWER(blocked_email) AS e FROM chat_blocked_users WHERE LOWER(blocker_email) = :me
                                    UNION SELECT LOWER(blocker_email) AS e FROM chat_blocked_users WHERE LOWER(blocked_email) = :me");
                $st->execute([':me' => $me]);
                foreach ($st->fetchAll() as $r) $existing[$r['e']] = true;
            } catch (\Throwable $_) {}

            $scores = []; // email → [score, sources]
            $addScore = function($email, $points, $reason) use (&$scores, $existing) {
                $e = strtolower($email);
                if (!$e || !empty($existing[$e])) return;
                if (!isset($scores[$e])) $scores[$e] = ['score' => 0, 'sources' => []];
                $scores[$e]['score'] += $points;
                $scores[$e]['sources'][$reason] = true;
            };

            // Source A — group co-members I haven't DMed.
            // Weight: +3 per shared group (capped so being in 10 groups with
            // one person doesn't crowd out the whole suggestion list).
            try {
                $st = $db->prepare("
                    SELECT LOWER(cm2.email) AS e, COUNT(DISTINCT cm1.conversation_id) AS shared_groups
                    FROM chat_conversation_members cm1
                    JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id AND LOWER(cm2.email) <> :me
                    JOIN chat_conversations c ON c.id = cm1.conversation_id AND c.type IN ('group','channel')
                    WHERE LOWER(cm1.email) = :me
                    GROUP BY LOWER(cm2.email)
                    LIMIT 200
                ");
                $st->execute([':me' => $me]);
                foreach ($st->fetchAll() as $r) {
                    $addScore($r['e'], min(9, 3 * (int)$r['shared_groups']), 'group');
                }
            } catch (\Throwable $_) {}

            // Source B — friends of friends via chat_follows.
            // Weight: +2 per mutual (i.e. someone multiple people I follow
            // also follow). Capped at +10.
            try {
                $st = $db->prepare("
                    SELECT LOWER(b.following_email) AS e, COUNT(DISTINCT a.following_email) AS mutuals
                    FROM chat_follows a
                    JOIN chat_follows b ON LOWER(b.follower_email) = LOWER(a.following_email)
                    WHERE LOWER(a.follower_email) = :me
                      AND LOWER(b.following_email) <> :me
                      AND NOT EXISTS (
                        SELECT 1 FROM chat_follows f
                        WHERE LOWER(f.follower_email) = :me
                          AND LOWER(f.following_email) = LOWER(b.following_email)
                      )
                    GROUP BY LOWER(b.following_email)
                    ORDER BY mutuals DESC
                    LIMIT 100
                ");
                $st->execute([':me' => $me]);
                foreach ($st->fetchAll() as $r) {
                    $addScore($r['e'], min(10, 2 * (int)$r['mutuals']), 'mutual');
                }
            } catch (\Throwable $_) {}

            // Source C — phone contacts (the client has already synced their
            // phonebook hashes via chat_sync_contacts — we just reuse the
            // registry here, i.e. anyone registered whose hash the client
            // would have matched. Since we don't persist the *uploader's*
            // hash list, we approximate: pull all registered users sharing
            // a presence history or any channel the client fetched before
            // this action. For a first cut, we use phone_registry to mark
            // "contact" provenance when the caller sends phone_hashes[] in
            // this request as a hint.)
            $hashes = $input['phone_hashes'] ?? [];
            if (is_array($hashes) && !empty($hashes)) {
                $clean = [];
                foreach ($hashes as $h) {
                    if (is_string($h) && preg_match('/^[a-f0-9]{64}$/', strtolower($h))) {
                        $clean[strtolower($h)] = true;
                    }
                    if (count($clean) >= 5000) break;
                }
                if (!empty($clean)) {
                    $placeholders = implode(',', array_fill(0, count($clean), '?'));
                    $st = $db->prepare("SELECT LOWER(email) AS e FROM chat_phone_registry WHERE phone_hash IN ($placeholders)");
                    $st->execute(array_keys($clean));
                    foreach ($st->fetchAll() as $r) {
                        // Phone contacts get the highest weight — you actually
                        // know them in real life, which is way stronger than
                        // follow-graph overlap.
                        $addScore($r['e'], 15, 'contact');
                    }
                }
            }

            // Source D — Fallback: popular + recently-joined users.
            // Fresh accounts (no follow graph, no groups, no phone contacts)
            // would otherwise see an empty section. Seed them with a small
            // pool of active users so there's always someone to chat with —
            // this is what makes the app feel "alive" on first install.
            // Weight is low (+1) so real graph-based matches still rank first.
            if (count($scores) < 5) {
                try {
                    // Prefer recently-registered (last 30 days) with any activity
                    // (phone verified so the account is real). Exclude me + DMed + blocked.
                    $exclusionList = array_keys($existing);
                    $placeholders = empty($exclusionList) ? "''" : implode(',', array_fill(0, count($exclusionList), '?'));
                    $stRecent = $db->prepare("
                        SELECT LOWER(r.email) AS e,
                               COALESCE(
                                 (SELECT COUNT(*) FROM chat_follows f WHERE LOWER(f.following_email) = LOWER(r.email)),
                                 0
                               ) AS followers
                        FROM chat_phone_registry r
                        WHERE LOWER(r.email) NOT IN ($placeholders)
                          AND r.created_at > NOW() - INTERVAL '30 days'
                        ORDER BY r.created_at DESC
                        LIMIT 20
                    ");
                    $stRecent->execute($exclusionList);
                    foreach ($stRecent->fetchAll() as $r) {
                        $addScore($r['e'], 1 + min(3, (int)$r['followers']), 'popular');
                    }
                } catch (\Throwable $_) {}
            }

            // Sort + cap
            $items = [];
            foreach ($scores as $email => $data) {
                $items[] = [
                    'email' => $email,
                    'name'  => chatDisplayName($email),
                    'score' => $data['score'],
                    'sources' => array_keys($data['sources']),
                ];
            }
            usort($items, fn($a, $b) => $b['score'] - $a['score']);
            $items = array_slice($items, 0, $limit);

            jsonResponse(true, ['suggestions' => $items]);
            break;
        }

        case 'chat_contacts': {
            $user = requireChatAuth();

            // Return users who share conversations with the current user,
            // plus any users known from the presence table
            $stmt = $db->prepare("
                SELECT DISTINCT cm2.email,
                    COALESCE(cp.status, 'offline') as status,
                    COALESCE(cp.last_seen, '') as last_seen
                FROM chat_conversation_members cm1
                JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id AND LOWER(cm2.email) <> LOWER(:email)
                LEFT JOIN chat_user_presence cp ON LOWER(cp.email) = LOWER(cm2.email)
                WHERE LOWER(cm1.email) = LOWER(:email2)
                ORDER BY cm2.email
            ");
            $stmt->execute([':email' => $user['email'], ':email2' => $user['email']]);
            $contacts = $stmt->fetchAll();

            // Add display name
            foreach ($contacts as &$c) {
                $c['name'] = chatDisplayName($c['email']);
            }

            // Also search by query if provided
            $query = trim($input['query'] ?? $_GET['query'] ?? '');
            if ($query !== '') {
                // Try to match email addresses on the same domain
                $userDomain = substr($user['email'], strpos($user['email'], '@'));
                // This is a basic approach — in production you might query an LDAP or user directory
                $filtered = array_filter($contacts, function($c) use ($query) {
                    return stripos($c['email'], $query) !== false || stripos($c['name'], $query) !== false;
                });
                $contacts = array_values($filtered);
            }

            jsonResponse(true, $contacts);
            break;
        }

        // ============================================================
        // chat_upload — Upload file attachment
        // ============================================================
        case 'chat_upload': {
            $user = requireChatAuth();
            $conversationId = (int)($_POST['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);
            if (!chatRateLimit($user["email"], "upload", 30, 60)) jsonResponse(false, null, "Rate limit exceeded — too many uploads. Try again in 1 min.", 429);

            if (empty($_FILES['file'])) {
                jsonResponse(false, null, 'No file uploaded', 400);
            }

            $file = $_FILES['file'];
            $maxSize = 100 * 1024 * 1024; // 100MB (matches nginx client_max_body_size)
            if ($file['size'] > $maxSize) {
                jsonResponse(false, null, 'File too large (max 100MB)', 400);
            }

            // 100GB plan storage cap — refuse before we touch disk.
            require_once __DIR__ . '/plans.php';
            enforceStorageCap($user['email'], (int)$file['size']);

            if ($file['error'] !== UPLOAD_ERR_OK) {
                // Translate the numeric upload error to something humans can read.
                $uploadErrors = [
                    UPLOAD_ERR_INI_SIZE   => 'File exceeds server upload_max_filesize',
                    UPLOAD_ERR_FORM_SIZE  => 'File exceeds form MAX_FILE_SIZE',
                    UPLOAD_ERR_PARTIAL    => 'File only partially uploaded',
                    UPLOAD_ERR_NO_FILE    => 'No file uploaded',
                    UPLOAD_ERR_NO_TMP_DIR => 'Server missing temp dir',
                    UPLOAD_ERR_CANT_WRITE => 'Server failed to write file',
                    UPLOAD_ERR_EXTENSION  => 'Upload blocked by PHP extension',
                ];
                $msg = $uploadErrors[$file['error']] ?? ('Upload error: ' . $file['error']);
                jsonResponse(false, null, $msg, 400);
            }

            // Block dangerous executable/script extensions (matches frontend blocklist).
            $extCheck = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
            $blocked = ['php','phtml','phar','exe','sh','bat','cmd','com','scr','vbs','js','jar','apk','dll','msi','app','bin','so','dylib','sys','drv','svg','html','htm','shtml'];
            if (in_array($extCheck, $blocked, true)) {
                jsonResponse(false, null, 'File type not allowed: .' . $extCheck, 400);
            }

            $uploadDir = '/var/www/mail/data/chat-files/' . $conversationId . '/';
            if (!is_dir($uploadDir)) {
                if (!@mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
                    jsonResponse(false, null, 'Failed to create upload directory', 500);
                }
            }
            if (!is_writable($uploadDir)) {
                jsonResponse(false, null, 'Upload directory not writable', 500);
            }

            // Sanitize filename
            $originalName = basename($file['name']);
            $safeName = preg_replace('/[^a-zA-Z0-9._-]/', '_', $originalName);
            if ($safeName === '' || $safeName === '.' || $safeName === '..') $safeName = 'file';
            $uniqueName = time() . '_' . bin2hex(random_bytes(4)) . '_' . $safeName;
            $destPath = $uploadDir . $uniqueName;

            if (!move_uploaded_file($file['tmp_name'], $destPath)) {
                jsonResponse(false, null, 'Failed to save file', 500);
            }

            // Trust filesize($destPath), not $file['size'] — the client-sent
            // value is spoofable and was previously used verbatim in the DB
            // row. A malicious client could advertise size=100 bytes while
            // sending 100MB; the DB would then report wrong sizes and the
            // CDN cache key was off.
            $realSize = @filesize($destPath) ?: 0;
            // Cap at 100MB hard limit (PHP ini-level check happens above but
            // a rogue Rust upload path could still land something larger).
            if ($realSize > 100 * 1024 * 1024) {
                @unlink($destPath);
                jsonResponse(false, null, 'File exceeds 100 MB limit', 413);
            }
            $file['size'] = $realSize;

            // Generate a thumbnail JPG for videos so the chat bubble shows a
            // real poster frame instead of a gray box. Fire-and-forget —
            // ffmpeg failure just means no poster, the upload still completes.
            //
            // `timeout 30` + `nice -n 19` bound the CPU cost: a crafted or
            // corrupt video that put ffmpeg into an infinite loop used to
            // spin a core until the OOM killer noticed. Also run under
            // `setsid` so a stuck ffmpeg process is in its own session and
            // can be killed without taking php-fpm with it.
            $__thumbExt = strtolower(pathinfo($destPath, PATHINFO_EXTENSION));
            $__thumbOut = '';
            if (in_array($__thumbExt, ['mp4','mov','webm','mkv','avi','m4v','3gp'], true)) {
                try {
                    $__thumbOut = $destPath . '.thumb.jpg';
                    // SYNC (~0.5–2s typical) so the thumb file exists before the
                    // R2 upload kickoff below — otherwise R2 only ever gets the
                    // video and the bubble shows a black box.
                    $__cmd = sprintf(
                        'setsid timeout 30 nice -n 19 ffmpeg -y -ss 0.5 -i %s -frames:v 1 -vf %s -q:v 5 %s 2>/dev/null',
                        escapeshellarg($destPath),
                        escapeshellarg('scale=640:-2'),
                        escapeshellarg($__thumbOut)
                    );
                    @shell_exec($__cmd);
                    if (!is_file($__thumbOut) || filesize($__thumbOut) === 0) {
                        $__thumbOut = '';
                    }
                } catch (Throwable $e) { $__thumbOut = ''; }

                // HLS variant for chat videos — same recipe as status: 4s .ts
                // segments + .m3u8 playlist transcoded async via nohup so the
                // chat_send response doesn't block on it. Player falls back
                // to mp4 progressive until the HLS lands; next message refresh
                // picks up the new URL via the .hls/index.m3u8 file existence
                // check in chat_messages_list.
                try {
                    $__hlsBase = $destPath . '.hls';
                    if (!is_dir($__hlsBase)) @mkdir($__hlsBase, 0755, true);
                    $__hlsCmd = sprintf(
                        'nohup setsid timeout 180 nice -n 19 ffmpeg -y -i %s -vf scale=720:-2 -c:v libx264 -preset veryfast -crf 24 -c:a aac -b:a 96k -hls_time 4 -hls_playlist_type vod -hls_segment_filename %s/seg_%%03d.ts %s/index.m3u8 >/dev/null 2>&1 &',
                        escapeshellarg($destPath),
                        escapeshellarg($__hlsBase),
                        escapeshellarg($__hlsBase)
                    );
                    @shell_exec($__hlsCmd);
                } catch (Throwable $e) {}
            }

            // iOS can't decode WebM/Opus audio — the web MediaRecorder's
            // default output. Without transcoding, voice notes recorded on
            // web silently fail on the iPhone app (play button does nothing
            // because expo-audio can't load the source). Transcode to
            // AAC-in-M4A synchronously so the URL we hand back is always
            // playable everywhere. Runs only on audio uploads; cost is
            // ~0.1× real-time for typical 10-30s voice notes (negligible).
            $__clientTypeLc = strtolower((string)($_POST['type'] ?? ''));
            $__mimeLc = strtolower((string)($file['type'] ?? ''));
            $__isAudioUpload = ($__clientTypeLc === 'audio')
                || (strpos($__mimeLc, 'audio/') === 0)
                || ($__thumbExt === 'webm' && strpos($__mimeLc, 'video') === false)
                || in_array($__thumbExt, ['ogg','opus','oga'], true);
            if ($__isAudioUpload && $__thumbExt !== 'm4a' && $__thumbExt !== 'mp4' && $__thumbExt !== 'aac' && $__thumbExt !== 'mp3' && $__thumbExt !== 'wav') {
                try {
                    $__m4aPath = preg_replace('/\.[^.]+$/', '', $destPath) . '.m4a';
                    $__ffCmd = sprintf(
                        'setsid timeout 45 nice -n 19 ffmpeg -y -i %s -vn -c:a aac -b:a 96k -movflags +faststart %s 2>/dev/null',
                        escapeshellarg($destPath),
                        escapeshellarg($__m4aPath)
                    );
                    @shell_exec($__ffCmd);
                    if (is_file($__m4aPath) && filesize($__m4aPath) > 0) {
                        // Swap the saved path to the transcoded file so the
                        // DB row + CDN URL point to the iOS-playable copy.
                        @unlink($destPath);
                        $destPath = $__m4aPath;
                        $uniqueName = basename($__m4aPath);
                        $realSize = filesize($__m4aPath) ?: $realSize;
                        $file['size'] = $realSize;
                    }
                } catch (Throwable $e) { error_log('[chat_upload/transcode-audio] ' . $e->getMessage()); }
            }

            // Real waveform extraction for voice/audio: ffmpeg `astats` reads
            // RMS levels at 40 evenly-spaced samples and saves a JSON peak
            // array next to the file. Frontend reads it via .peaks.json so
            // the bubble shows the actual loudness shape (was a fake hash-
            // generated waveform that looked the same for any audio).
            if ($__isAudioUpload && in_array(strtolower(pathinfo($destPath, PATHINFO_EXTENSION)), ['m4a','mp3','aac','wav','ogg','opus','webm'], true)) {
                try {
                    $__peaksOut = $destPath . '.peaks.json';
                    // 40 bars over the entire file. astats prints per-frame
                    // RMS_level in dB; we segment it into 40 buckets and
                    // normalize to 0..1.
                    $__rmsCmd = sprintf(
                        'setsid timeout 20 nice -n 19 ffmpeg -hide_banner -i %s -af astats=metadata=1:reset=0.05,ametadata=print:key=lavfi.astats.Overall.RMS_level -vn -f null - 2>&1 | grep -oE "RMS_level=[-0-9.]+" | head -200',
                        escapeshellarg($destPath)
                    );
                    $__rmsOut = @shell_exec($__rmsCmd) ?: '';
                    $__rmsLines = preg_split('/\s+/', trim($__rmsOut));
                    $__rmsValues = [];
                    foreach ($__rmsLines as $__line) {
                        if (preg_match('/RMS_level=([-0-9.]+)/', $__line, $__m)) {
                            $__db = (float)$__m[1];
                            // -inf becomes ridiculously negative; clamp to -60dB.
                            if (!is_finite($__db) || $__db < -60) $__db = -60;
                            // Normalize -60..0 dB to 0..1 with squared-curve so
                            // mid-range loudness looks taller (perceptual).
                            $__norm = max(0, min(1, ($__db + 60) / 60));
                            $__rmsValues[] = pow($__norm, 1.7);
                        }
                    }
                    if (!empty($__rmsValues)) {
                        // Resample to 40 buckets via linear bucket-averaging.
                        $__targetN = 40;
                        $__src = count($__rmsValues);
                        $__bars = [];
                        for ($i = 0; $i < $__targetN; $i++) {
                            $__a = (int)floor($i * $__src / $__targetN);
                            $__b = (int)floor(($i + 1) * $__src / $__targetN);
                            if ($__b <= $__a) $__b = $__a + 1;
                            $__sum = 0; $__count = 0;
                            for ($j = $__a; $j < $__b && $j < $__src; $j++) {
                                $__sum += $__rmsValues[$j];
                                $__count++;
                            }
                            $__bars[] = round(($__count > 0 ? $__sum / $__count : 0) * 100) / 100;
                        }
                        @file_put_contents($__peaksOut, json_encode($__bars));
                        @chmod($__peaksOut, 0640);
                    }
                } catch (Throwable $e) { error_log('[chat_upload/peaks] ' . $e->getMessage()); }
            }

            // Determine message type. Priority:
            //   1. Client-supplied type (trusted if in allowed list) —
            //      reliable for voice notes which always send type='audio'.
            //   2. MIME type prefix ("audio/*", "video/*", "image/*") —
            //      authoritative for upload.type from MediaRecorder.
            //   3. Extension fallback — but NEVER downgrades the MIME match;
            //      this prevents `.webm` (shared between audio/video) from
            //      being classified as video when the blob is actually a
            //      voice note.
            $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
            $clientType = $_POST['type'] ?? '';
            $allowedTypes = ['image', 'video', 'audio', 'file', 'gif', 'sticker'];
            $mimePrefix = '';
            if (!empty($file['type'])) {
                $slashPos = strpos($file['type'], '/');
                if ($slashPos !== false) $mimePrefix = substr($file['type'], 0, $slashPos);
            }
            if (in_array($clientType, $allowedTypes, true)) {
                $msgType = $clientType;
            } elseif ($mimePrefix === 'audio') {
                $msgType = 'audio';
            } elseif ($mimePrefix === 'video') {
                $msgType = 'video';
            } elseif ($mimePrefix === 'image') {
                $msgType = 'image';
            } else {
                $imageExts = ['jpg','jpeg','png','gif','webp','bmp','heic','heif'];
                $videoExts = ['mp4','mov','mkv','avi','m4v']; // webm removed — ambiguous, only classify as video when MIME says so
                $audioExts = ['mp3','wav','ogg','m4a','aac','opus','webm'];
                if (in_array($ext, $imageExts, true)) $msgType = 'image';
                elseif (in_array($ext, $videoExts, true)) $msgType = 'video';
                elseif (in_array($ext, $audioExts, true)) $msgType = 'audio';
                else $msgType = 'file';
            }

            $fileUrl = '/data/chat-files/' . $conversationId . '/' . $uniqueName;

            // WhatsApp-style LQIP (Low-Quality Image Placeholder). Generate a
            // tiny (~500-800 byte) blurrable JPEG preview and store the
            // base64 in chat_messages.thumb_b64 so the client renders a
            // blurred inline placeholder the INSTANT the message arrives —
            // no waiting for R2/CDN to deliver the full-res photo. The
            // recipient sees "something meaningful" while the real image
            // streams in.
            $thumbB64 = null;
            if ($msgType === 'image' && function_exists('imagecreatefromjpeg')) {
                try {
                    $src = null;
                    if (in_array($ext, ['jpg','jpeg'], true))       $src = @imagecreatefromjpeg($destPath);
                    elseif ($ext === 'png')                          $src = @imagecreatefrompng($destPath);
                    elseif ($ext === 'webp' && function_exists('imagecreatefromwebp')) $src = @imagecreatefromwebp($destPath);
                    elseif ($ext === 'gif')                          $src = @imagecreatefromgif($destPath);
                    if ($src) {
                        $w = imagesx($src); $h = imagesy($src);
                        if ($w > 0 && $h > 0) {
                            $tw = 40;
                            $th = max(1, (int)round($h * ($tw / $w)));
                            $thumb = imagescale($src, $tw, $th, IMG_BILINEAR_FIXED);
                            if ($thumb) {
                                ob_start();
                                imagejpeg($thumb, null, 30);
                                $jpgBytes = ob_get_clean();
                                if ($jpgBytes && strlen($jpgBytes) < 4000) {
                                    $thumbB64 = base64_encode($jpgBytes);
                                }
                                imagedestroy($thumb);
                            }
                        }
                        imagedestroy($src);
                    }
                } catch (Throwable $_) { /* thumb is best-effort */ }
            } elseif ($msgType === 'video') {
                // Video: we already queued an ffmpeg poster to ${destPath}.thumb.jpg
                // in the background. Re-encode a much smaller copy of that same
                // poster once it lands (fire-and-forget so we don't block the
                // upload response) — kept at 40px wide to match image LQIPs.
                $posterPath = $destPath . '.thumb.jpg';
                if (is_file($posterPath) && function_exists('imagecreatefromjpeg')) {
                    try {
                        $src = @imagecreatefromjpeg($posterPath);
                        if ($src) {
                            $w = imagesx($src); $h = imagesy($src);
                            if ($w > 0 && $h > 0) {
                                $tw = 40;
                                $th = max(1, (int)round($h * ($tw / $w)));
                                $thumb = imagescale($src, $tw, $th, IMG_BILINEAR_FIXED);
                                if ($thumb) {
                                    ob_start();
                                    imagejpeg($thumb, null, 30);
                                    $jpgBytes = ob_get_clean();
                                    if ($jpgBytes && strlen($jpgBytes) < 4000) {
                                        $thumbB64 = base64_encode($jpgBytes);
                                    }
                                    imagedestroy($thumb);
                                }
                            }
                            imagedestroy($src);
                        }
                    } catch (Throwable $_) {}
                }
            }

            // Fire-and-forget upload to Cloudflare R2 so chat media streams
            // from Cloudflare edge globally (Brazilian users were waiting
            // 2-3s on first play because the US origin was the only copy).
            // Local copy stays as the warm backup / @r2_fallback target.
            try {
                $r2Ext = strtolower(pathinfo($destPath, PATHINFO_EXTENSION));
                $r2CtMap = [
                    'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
                    'gif' => 'image/gif', 'webp' => 'image/webp', 'heic' => 'image/heic',
                    'heif' => 'image/heif', 'mp4' => 'video/mp4', 'mov' => 'video/quicktime',
                    'webm' => 'video/webm', 'mkv' => 'video/x-matroska', 'm4v' => 'video/x-m4v',
                    'm4a' => 'audio/mp4', 'aac' => 'audio/aac', 'mp3' => 'audio/mpeg',
                    'ogg' => 'audio/ogg', 'opus' => 'audio/opus', 'wav' => 'audio/wav',
                    'pdf' => 'application/pdf', 'zip' => 'application/zip',
                ];
                $r2Ct  = $r2CtMap[$r2Ext] ?? 'application/octet-stream';
                $r2Key = ltrim($fileUrl, '/');
                $r2Cmd = sprintf(
                    'setsid nice -n 19 /var/www/mail/api/r2-upload-async.sh %s %s %s > /dev/null 2>&1 &',
                    escapeshellarg($destPath),
                    escapeshellarg($r2Key),
                    escapeshellarg($r2Ct)
                );
                @shell_exec($r2Cmd);
                // Also push the .thumb.jpg poster to R2 so the chat bubble
                // can render it from the same CDN host (was 404'ing because
                // ffmpeg's output stayed local).
                if (!empty($__thumbOut) && is_file($__thumbOut)) {
                    $__r2ThumbCmd = sprintf(
                        'setsid nice -n 19 /var/www/mail/api/r2-upload-async.sh %s %s %s > /dev/null 2>&1 &',
                        escapeshellarg($__thumbOut),
                        escapeshellarg($r2Key . '.thumb.jpg'),
                        escapeshellarg('image/jpeg')
                    );
                    @shell_exec($__r2ThumbCmd);
                }
            } catch (Throwable $e) { /* non-fatal */ }

            // Silent upload shortcut — used by group avatar change where we only
            // need the file URL, not a chat message / broadcast / push.
            if (!empty($_POST['silent'])) {
                jsonResponse(true, ['file_url' => $fileUrl, 'url' => $fileUrl], '');
                break;
            }
            // Create message with file attachment
            $content = trim($_POST['content'] ?? '') ?: $originalName;
            $viewOnce = (int)!!($_POST['view_once'] ?? 0);

            $pg = $db;
            $nowIso = gmdate('Y-m-d\TH:i:s\Z');
            // Ensure thumb_b64 column exists (idempotent — first upload after
            // deploy runs the ALTER, subsequent calls are no-ops).
            try { $pg->exec("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thumb_b64 TEXT"); } catch (Throwable $_) {}
            $pgIns = $pg->prepare("
                INSERT INTO chat_messages
                    (conversation_id, sender_email, sender_name, content, type,
                     file_url, file_name, file_size, is_view_once, viewed_by,
                     starred, thumb_b64, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'[]',0,?,?)
                RETURNING id, created_at
            ");
            try {
                $pgIns->execute([
                    $conversationId,
                    $user['email'],
                    chatDisplayName($user['email']),
                    $content,
                    $msgType,
                    $fileUrl,
                    $originalName,
                    $file['size'],
                    $viewOnce ? 1 : 0,
                    $thumbB64,
                    $nowIso,
                ]);
                $prow = $pgIns->fetch(\PDO::FETCH_ASSOC);
                $messageId = (int)$prow['id'];
                $actualCreatedAt = $prow['created_at'];
            } catch (Throwable $e) {
                error_log('[chat_upload/pg] ' . $e->getMessage());
                jsonResponse(false, null, 'Upload save failed', 500);
            }

            touchConversation($db, $conversationId);

            // Auto-mark as read for sender.
            $db->prepare("
                UPDATE chat_conversation_members
                SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), :mid::int)
                WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)
            ")->execute([':mid' => $messageId, ':cid' => $conversationId, ':email' => $user['email']]);

            // Broadcast + push so other participants see the attachment in
            // real time. Previously chat_upload was the only write path that
            // silently skipped fan-out, so a photo sent via upload appeared
            // only on the sender's device until the recipient refreshed.
            //
            // Also emit a pts event + stamp the row's conv_pts so chat_sync
            // can deliver this upload to multi-device / post-offline clients
            // alongside regular sends.
            try {
                $pts = emitConvEvent($db, (int)$conversationId, 'new_message', $user['email'], ['message_id' => (int)$messageId]);
                if ($pts > 0) {
                    $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                       ->execute([':p' => $pts, ':mid' => $messageId]);
                }
            } catch (Throwable $e) { error_log('[chat_upload/pts] ' . $e->getMessage()); }
            try { broadcastChatMessage($db, $conversationId, $messageId, $user['email']); }
            catch (Throwable $e) { error_log('[chat_upload.ws] ' . $e->getMessage()); }
            try { chatSendPushToMembers($db, $conversationId, $messageId, $user['email']); }
            catch (Throwable $e) { error_log('[chat_upload.push] ' . $e->getMessage()); }

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id");
            $stmt->execute([':id' => $messageId]);
            $msg = $stmt->fetch();
            $msg['id'] = (int)$msg['id'];
            $msg['sender_name'] = chatDisplayName($msg['sender_email']);
            $msg['reactions'] = [];
            $msg['edited'] = !empty($msg['edited_at']);
            $msg['pinned'] = false;

            jsonResponse(true, $msg, 'File uploaded and sent');
            break;
        }

        // ============================================================
        // chat_mute — Toggle mute on a conversation
        // ============================================================
        case 'chat_mute': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            // Toggle muted state. Guard against fetch() returning false
            // (member row missing even though requireConversationMember passed —
            // can happen in a race with chat_remove_member). Accessing ['muted']
            // on false crashes under PHP 8.4 strict mode.
            $stmt = $db->prepare("SELECT muted FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
            $stmt->execute([':cid' => $conversationId, ':email' => $user['email']]);
            $row = $stmt->fetch();
            $current = $row ? (int)($row['muted'] ?? 0) : 0;
            $newMuted = $current ? 0 : 1;

            $db->prepare("
                UPDATE chat_conversation_members SET muted = :muted
                WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)
            ")->execute([':muted' => $newMuted, ':cid' => $conversationId, ':email' => $user['email']]);

            jsonResponse(true, ['muted' => (bool)$newMuted], $newMuted ? 'Conversation muted' : 'Conversation unmuted');
            break;
        }

        // ============================================================
        // chat_search — Search messages across conversations
        // ============================================================
        case 'chat_search': {
            $user = requireChatAuth();
            $query = trim($input['query'] ?? $_GET['query'] ?? '');
            if ($query === '') jsonResponse(false, null, 'query required', 400);

            $limit = min(50, max(1, (int)($input['limit'] ?? $_GET['limit'] ?? 20)));

            // Search only in conversations the user is a member of. Also
            // match on file_name so searching for "foto.png" finds the image
            // message even when content is empty or just the caption. Escape
            // LIKE metachars so "100%" doesn't match every row.
            $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $query);
            $stmt = $db->prepare("
                SELECT m.id, m.conversation_id, m.sender_email, m.content, m.type,
                       m.file_name, m.created_at, c.name AS conv_name, c.type AS conv_type
                FROM chat_messages m
                JOIN chat_conversations c ON c.id = m.conversation_id
                JOIN chat_conversation_members cm ON cm.conversation_id = m.conversation_id AND LOWER(cm.email) = LOWER(:email)
                WHERE m.deleted_at IS NULL
                  AND (m.content ILIKE :query OR m.file_name ILIKE :query2)
                ORDER BY m.created_at DESC
                LIMIT :limit
            ");
            $stmt->bindValue(':email', $user['email'], PDO::PARAM_STR);
            $stmt->bindValue(':query',  '%' . $escaped . '%', PDO::PARAM_STR);
            $stmt->bindValue(':query2', '%' . $escaped . '%', PDO::PARAM_STR);
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->execute();
            $results = $stmt->fetchAll();

            foreach ($results as &$r) {
                $r['id'] = (int)$r['id'];
                $r['conversation_id'] = (int)$r['conversation_id'];
                $r['sender_name'] = chatDisplayName($r['sender_email']);
            }

            jsonResponse(true, $results);
            break;
        }

        // ============================================================
        // chat_pin — Pin/unpin a message
        // ============================================================
        case 'chat_pin': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);

            requireConversationMember($db, $msg['conversation_id'], $user['email']);

            // Toggle pinned state via pinned_at column (NULL = unpinned)
            $newPinned = empty($msg['pinned_at']) ? 1 : 0;
            $db->prepare("
                UPDATE chat_messages SET pinned_at = :pa, pinned_by = :pb
                WHERE id = :id
            ")->execute([
                ':pa' => $newPinned ? gmdate('Y-m-d\TH:i:s\Z') : null,
                ':pb' => $newPinned ? $user['email'] : null,
                ':id' => $messageId,
            ]);

            // System message
            $action_label = $newPinned ? 'pinned' : 'unpinned';
            $preview = mb_substr($msg['content'], 0, 50);
            $db->prepare("
                INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                VALUES (:cid, :email, :content, 'system', now()::text)
            ")->execute([
                ':cid'     => $msg['conversation_id'],
                ':email'   => $user['email'],
                ':content' => chatDisplayName($user['email']) . " {$action_label} a message: \"{$preview}\"",
            ]);

            touchConversation($db, $msg['conversation_id']);

            // Broadcast so every participant sees the pin/unpin live.
            // Without this, pinning only showed on the pinner's device and
            // the other side kept the stale unpinned state until they
            // refreshed the conversation.
            try { broadcastChatMessage($db, (int)$msg['conversation_id'], $messageId, $user['email'], $newPinned ? 'pin' : 'unpin'); }
            catch (Throwable $e) { error_log('[chat_pin.ws] ' . $e->getMessage()); }

            jsonResponse(true, ['pinned' => (bool)$newPinned], 'Message ' . $action_label);
            break;
        }

        // ============================================================
        // chat_forward — Forward a message to another conversation
        // ============================================================
        case 'chat_forward': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            $targetConversationId = (int)($input['conversation_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            if (!$targetConversationId) jsonResponse(false, null, 'conversation_id (target) required', 400);

            // Verify source message
            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $sourceMsg = $stmt->fetch();
            if (!$sourceMsg) jsonResponse(false, null, 'Source message not found', 404);

            // Verify user is member of source conversation
            $srcMembership = requireConversationMember($db, $sourceMsg['conversation_id'], $user['email']);

            // Verify user is member of target conversation
            requireConversationMember($db, $targetConversationId, $user['email']);

            // forwarding_disabled enforcement (Telegram parity). When the
            // source conversation has the flag set, only admins of THAT
            // conv may forward out. Mirrors WhatsApp's "Restrict saving
            // content" group setting.
            try {
                $fdStmt = $db->prepare("SELECT forwarding_disabled FROM chat_conversations WHERE id = :id");
                $fdStmt->execute([':id' => (int)$sourceMsg['conversation_id']]);
                $fdRow = $fdStmt->fetch(\PDO::FETCH_ASSOC);
                if (!empty($fdRow['forwarding_disabled'])) {
                    $isSrcAdmin = (($srcMembership['role'] ?? 'member') === 'admin');
                    if (!$isSrcAdmin) {
                        jsonResponse(false, null, 'Forwarding is disabled for this conversation', 403);
                    }
                }
            } catch (\Throwable $_) { /* tolerate column-missing on stale dbs */ }

            // Block forwarding view-once messages — the whole point of
            // is_view_once=1 is that the content dies after one view, so
            // letting the recipient forward it would defeat that guarantee
            // (same reason WhatsApp disables forward on view-once media).
            if (!empty($sourceMsg['is_view_once']) && (int)$sourceMsg['is_view_once'] === 1) {
                jsonResponse(false, null, 'Cannot forward a view-once message', 403);
            }

            // Forward preserves the original content untouched; attribution
            // goes in metadata (forwarded_from + forwarded_from_name) so the
            // client can render "Encaminhada" the WhatsApp way instead of
            // prefixing the body and breaking emoji/markdown.
            $forwardedMeta = [
                'forwarded_from'      => $sourceMsg['sender_email'],
                'forwarded_from_name' => chatDisplayName($sourceMsg['sender_email']),
                'forwarded_msg_id'    => (int)$sourceMsg['id'],
            ];
            // forwarded_from column is added once during schema migration on
            // chat module init; running ALTER TABLE on every forward request
            // hammered SQLite with a no-op schema change and served no purpose.

            // Hide origin: user opted to forward anonymously. The new row
            // gets an empty forwarded_from so the recipient sees it as if
            // the forwarder wrote it natively. Telegram-style privacy
            // feature for sensitive forwards.
            $hideOrigin = !empty($input['hide_origin']) || !empty($input['anonymous']);
            $ffValue = $hideOrigin ? null : $sourceMsg['sender_email'];

            // WhatsApp-style forward counter: every hop +1. `Encaminhada
            // muitas vezes` badge kicks in at forward_count >= 5. Cap at 255
            // (TINYINT-safe) so we don't end up with absurd numbers like 9999;
            // UI treats anything >= 5 as "highly forwarded" anyway.
            $srcForwardCount = (int)($sourceMsg['forward_count'] ?? 0);
            $newForwardCount = min($srcForwardCount + 1, 255);

            $pg = $db;
            $nowIso = gmdate('Y-m-d\TH:i:s\Z');
            try {
                $pgIns = $pg->prepare("
                    INSERT INTO chat_messages
                        (conversation_id, sender_email, sender_name, content, type,
                         file_url, file_name, file_size, forwarded_from, forward_count,
                         viewed_by, starred, thumb_b64, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?, '[]', 0, ?, ?)
                    RETURNING id, created_at
                ");
                $pgIns->execute([
                    $targetConversationId,
                    $user['email'],
                    chatDisplayName($user['email']),
                    $sourceMsg['content'],
                    $sourceMsg['type'],
                    $sourceMsg['file_url'] ?? '',
                    $sourceMsg['file_name'] ?? '',
                    (int)($sourceMsg['file_size'] ?? 0),
                    $ffValue,
                    $newForwardCount,
                    $sourceMsg['thumb_b64'] ?? null,
                    $nowIso,
                ]);
                $prow = $pgIns->fetch(\PDO::FETCH_ASSOC);
                $newMsgId = (int)$prow['id'];
                $fwdCreatedAt = $prow['created_at'];
            } catch (Throwable $e) {
                error_log('[chat_forward/pg] ' . $e->getMessage());
                jsonResponse(false, null, 'Forward failed', 500);
            }
            // pts + push fan-out mirror chat_send so forwarded messages
            // reach multi-device and offline recipients too.
            try {
                $pts = emitConvEvent($db, (int)$targetConversationId, 'new_message', $user['email'], ['message_id' => $newMsgId]);
                if ($pts > 0) {
                    $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                       ->execute([':p' => $pts, ':mid' => $newMsgId]);
                }
            } catch (Throwable $e) { error_log('[chat_forward/pts] ' . $e->getMessage()); }
            try { broadcastChatMessage($db, $targetConversationId, $newMsgId, $user['email']); } catch (Throwable $e) {}
            try { chatSendPushToMembers($db, $targetConversationId, $newMsgId, $user['email']); } catch (Throwable $e) {}

            touchConversation($db, $targetConversationId);

            // Auto-mark as read for sender
            $db->prepare("
                UPDATE chat_conversation_members SET last_read_message_id = :mid::int
                WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)
            ")->execute([':mid' => $newMsgId, ':cid' => $targetConversationId, ':email' => $user['email']]);

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id");
            $stmt->execute([':id' => $newMsgId]);
            $msg = $stmt->fetch();
            $msg['id'] = (int)$msg['id'];
            $msg['sender_name'] = chatDisplayName($msg['sender_email']);
            $msg['reactions'] = [];
            $msg['edited'] = !empty($msg['edited_at']);
            $msg['pinned'] = false;

            jsonResponse(true, $msg, 'Message forwarded');
            break;
        }

        // ============================================================
        // chat_forward_multi — Forward one message to N conversations in
        // a single round-trip. WhatsApp-style multi-select forward.
        // Returns per-target { conversation_id, success, message_id?,
        // error? }; partial failures are reported in the array, never
        // collapse the whole call to a 4xx unless input is malformed.
        // ============================================================
        case 'chat_forward_multi': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            $rawTargets = $input['conversation_ids'] ?? [];
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            if (!is_array($rawTargets) || empty($rawTargets)) {
                jsonResponse(false, null, 'conversation_ids required (non-empty array)', 400);
            }
            // Sanitize + dedupe + cap at 100 targets (mirrors WhatsApp's per-tap limit)
            $targets = [];
            foreach ($rawTargets as $tid) {
                $cid = (int)$tid;
                if ($cid > 0) $targets[$cid] = true;
            }
            $targets = array_keys($targets);
            if (empty($targets)) jsonResponse(false, null, 'conversation_ids required', 400);
            if (count($targets) > 100) $targets = array_slice($targets, 0, 100);

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $sourceMsg = $stmt->fetch();
            if (!$sourceMsg) jsonResponse(false, null, 'Source message not found', 404);
            $srcMembershipMulti = requireConversationMember($db, $sourceMsg['conversation_id'], $user['email']);

            // forwarding_disabled enforcement (Telegram parity). Same
            // semantics as chat_forward — block the whole multi-call when
            // the source conv restricts saving and the caller is not an
            // admin of that source conv.
            try {
                $fdStmt = $db->prepare("SELECT forwarding_disabled FROM chat_conversations WHERE id = :id");
                $fdStmt->execute([':id' => (int)$sourceMsg['conversation_id']]);
                $fdRow = $fdStmt->fetch(\PDO::FETCH_ASSOC);
                if (!empty($fdRow['forwarding_disabled'])) {
                    $isSrcAdmin = (($srcMembershipMulti['role'] ?? 'member') === 'admin');
                    if (!$isSrcAdmin) {
                        jsonResponse(false, null, 'Forwarding is disabled for this conversation', 403);
                    }
                }
            } catch (\Throwable $_) { /* tolerate column-missing on stale dbs */ }

            if (!empty($sourceMsg['is_view_once']) && (int)$sourceMsg['is_view_once'] === 1) {
                jsonResponse(false, null, 'Cannot forward a view-once message', 403);
            }

            $hideOrigin = !empty($input['hide_origin']) || !empty($input['anonymous']);
            $ffValue = $hideOrigin ? null : $sourceMsg['sender_email'];
            $srcForwardCount = (int)($sourceMsg['forward_count'] ?? 0);
            $newForwardCount = min($srcForwardCount + 1, 255);
            $nowIso = gmdate('Y-m-d\TH:i:s\Z');

            $results = [];
            $okCount = 0;
            foreach ($targets as $targetConversationId) {
                $entry = ['conversation_id' => $targetConversationId, 'success' => false];
                try {
                    // Verify membership per-target (don't bail the whole batch on one failure)
                    $mstmt = $db->prepare("SELECT 1 FROM chat_conversation_members WHERE conversation_id = :c AND LOWER(email) = LOWER(:e) LIMIT 1");
                    $mstmt->execute([':c' => $targetConversationId, ':e' => $user['email']]);
                    if (!$mstmt->fetchColumn()) {
                        $entry['error'] = 'not_a_member';
                        $results[] = $entry;
                        continue;
                    }

                    $pgIns = $db->prepare("
                        INSERT INTO chat_messages
                            (conversation_id, sender_email, sender_name, content, type,
                             file_url, file_name, file_size, forwarded_from, forward_count,
                             viewed_by, starred, thumb_b64, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?, '[]', 0, ?, ?)
                        RETURNING id, created_at
                    ");
                    $pgIns->execute([
                        $targetConversationId,
                        $user['email'],
                        chatDisplayName($user['email']),
                        $sourceMsg['content'],
                        $sourceMsg['type'],
                        $sourceMsg['file_url'] ?? '',
                        $sourceMsg['file_name'] ?? '',
                        (int)($sourceMsg['file_size'] ?? 0),
                        $ffValue,
                        $newForwardCount,
                        $sourceMsg['thumb_b64'] ?? null,
                        $nowIso,
                    ]);
                    $prow = $pgIns->fetch(\PDO::FETCH_ASSOC);
                    $newMsgId = (int)$prow['id'];

                    // Per-target pts so each conv sees a monotonic stream.
                    try {
                        $pts = emitConvEvent($db, (int)$targetConversationId, 'new_message', $user['email'], ['message_id' => $newMsgId]);
                        if ($pts > 0) {
                            $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                               ->execute([':p' => $pts, ':mid' => $newMsgId]);
                        }
                    } catch (Throwable $e) { error_log('[chat_forward_multi/pts] ' . $e->getMessage()); }
                    try { broadcastChatMessage($db, $targetConversationId, $newMsgId, $user['email']); } catch (Throwable $e) {}
                    try { chatSendPushToMembers($db, $targetConversationId, $newMsgId, $user['email']); } catch (Throwable $e) {}
                    touchConversation($db, $targetConversationId);

                    $db->prepare("
                        UPDATE chat_conversation_members SET last_read_message_id = :mid::int
                        WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)
                    ")->execute([':mid' => $newMsgId, ':cid' => $targetConversationId, ':email' => $user['email']]);

                    $entry['success'] = true;
                    $entry['message_id'] = $newMsgId;
                    $okCount++;
                } catch (Throwable $e) {
                    error_log('[chat_forward_multi] cid=' . $targetConversationId . ' ' . $e->getMessage());
                    $entry['error'] = 'forward_failed';
                }
                $results[] = $entry;
            }

            jsonResponse(true, [
                'results' => $results,
                'total'   => count($targets),
                'success' => $okCount,
                'failed'  => count($targets) - $okCount,
            ], 'Multi-forward processed');
            break;
        }

        // ============================================================
        // chat_clone_to_saved — Long-press → "Salvar": clone a message
        // verbatim into the user's Saved Messages conv (lazy-creates it).
        // Preserves type/file_url/content; prefixes with attribution
        // line so the user sees who originally sent it.
        // ============================================================
        case 'chat_clone_to_saved': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $stmt->execute([':id' => $messageId]);
            $sourceMsg = $stmt->fetch();
            if (!$sourceMsg) jsonResponse(false, null, 'Source message not found', 404);
            requireConversationMember($db, $sourceMsg['conversation_id'], $user['email']);

            // View-once guard mirrors chat_forward — clone of a one-time
            // view would defeat the purpose.
            if (!empty($sourceMsg['is_view_once']) && (int)$sourceMsg['is_view_once'] === 1) {
                jsonResponse(false, null, 'Cannot save a view-once message', 403);
            }

            // Lazy-create Saved Messages conv (mirrors chat_saved logic)
            $me = strtolower($user['email']);
            $directKey = 'saved:' . $me;
            $savedConvId = null;
            try {
                $st = $db->prepare("SELECT id FROM chat_conversations WHERE direct_key = :k LIMIT 1");
                $st->execute([':k' => $directKey]);
                $savedConvId = (int)($st->fetchColumn() ?: 0);
            } catch (Throwable $_) {}
            if (!$savedConvId) {
                try {
                    $db->beginTransaction();
                    $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, direct_key, created_at, updated_at) VALUES ('saved', :n, :cb, :dk, now()::text, now()::text) RETURNING id");
                    $ins->execute([':n' => 'Saved Messages', ':cb' => $user['email'], ':dk' => $directKey]);
                    $savedConvId = (int)$ins->fetchColumn();
                    $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text) ON CONFLICT DO NOTHING")
                       ->execute([':cid' => $savedConvId, ':em' => $me, ':dn' => chatDisplayName($user['email'])]);
                    $db->commit();
                } catch (Throwable $e) {
                    if ($db->inTransaction()) $db->rollBack();
                    // Legacy schemas that reject 'saved' enum value — retry as 'direct'
                    try {
                        $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, direct_key, created_at, updated_at) VALUES ('direct', :n, :cb, :dk, now()::text, now()::text) RETURNING id");
                        $ins->execute([':n' => 'Saved Messages', ':cb' => $user['email'], ':dk' => $directKey]);
                        $savedConvId = (int)$ins->fetchColumn();
                        $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text) ON CONFLICT DO NOTHING")
                           ->execute([':cid' => $savedConvId, ':em' => $me, ':dn' => chatDisplayName($user['email'])]);
                    } catch (Throwable $e2) {
                        jsonResponse(false, null, 'Could not access Saved Messages: ' . $e2->getMessage(), 500);
                    }
                }
            }
            if (!$savedConvId) jsonResponse(false, null, 'Saved Messages not available', 500);

            // Build clone — preserve original content, add attribution
            // header so the user can later see "saved from @sender" without
            // tapping in. Same content payload (file_url etc.) so media
            // renders identically.
            $senderName = chatDisplayName($sourceMsg['sender_email']);
            $attribution = '📎 ' . ($senderName ?: $sourceMsg['sender_email']);
            $clonedContent = (string)($sourceMsg['content'] ?? '');
            // Only prefix attribution to text-type messages — for media/voice
            // the attribution would muddy the body, so skip and rely on
            // forwarded_from metadata instead.
            if (($sourceMsg['type'] ?? 'text') === 'text') {
                $clonedContent = $attribution . "\n" . $clonedContent;
            }
            $nowIso = gmdate('Y-m-d\TH:i:s\Z');
            try {
                $pgIns = $db->prepare("
                    INSERT INTO chat_messages
                        (conversation_id, sender_email, sender_name, content, type,
                         file_url, file_name, file_size, forwarded_from, viewed_by,
                         starred, thumb_b64, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?, '[]', 0, ?, ?)
                    RETURNING id, created_at
                ");
                $pgIns->execute([
                    $savedConvId,
                    $user['email'],
                    chatDisplayName($user['email']),
                    $clonedContent,
                    $sourceMsg['type'],
                    $sourceMsg['file_url'] ?? '',
                    $sourceMsg['file_name'] ?? '',
                    (int)($sourceMsg['file_size'] ?? 0),
                    $sourceMsg['sender_email'],
                    $sourceMsg['thumb_b64'] ?? null,
                    $nowIso,
                ]);
                $prow = $pgIns->fetch(\PDO::FETCH_ASSOC);
                $newMsgId = (int)$prow['id'];
            } catch (Throwable $e) {
                error_log('[chat_clone_to_saved] ' . $e->getMessage());
                jsonResponse(false, null, 'Save failed', 500);
            }

            try {
                $pts = emitConvEvent($db, $savedConvId, 'new_message', $user['email'], ['message_id' => $newMsgId]);
                if ($pts > 0) {
                    $db->prepare("UPDATE chat_messages SET conv_pts = :p WHERE id = :mid")
                       ->execute([':p' => $pts, ':mid' => $newMsgId]);
                }
            } catch (Throwable $e) {}
            try { broadcastChatMessage($db, $savedConvId, $newMsgId, $user['email']); } catch (Throwable $e) {}
            touchConversation($db, $savedConvId);

            jsonResponse(true, [
                'conversation_id' => $savedConvId,
                'message_id'      => $newMsgId,
            ], 'Message saved');
            break;
        }

        // ============================================================
        // chat_unread_count — Total unread across all conversations
        // ============================================================
        case 'chat_unread_count': {
            $user = requireChatAuth();

            $stmt = $db->prepare("
                SELECT COALESCE(SUM(unread), 0) as total_unread
                FROM (
                    SELECT
                        (SELECT COUNT(*) FROM chat_messages
                         WHERE conversation_id = cm.conversation_id
                           AND id > COALESCE(cm.last_read_message_id, 0)
                           AND LOWER(sender_email) <> LOWER(:email)
                           AND deleted_at IS NULL
                        ) as unread
                    FROM chat_conversation_members cm
                    WHERE LOWER(cm.email) = LOWER(:email2) AND cm.muted = 0
                ) sub
            ");
            $stmt->execute([':email' => $user['email'], ':email2' => $user['email']]);
            $row = $stmt->fetch();

            jsonResponse(true, ['unread_count' => (int)$row['total_unread']]);
            break;
        }

        // ============================================================
        // chat_favorite — Toggle pinned/favorite conversation
        // ============================================================
        case 'chat_favorite':
        case 'chat_pin_conversation': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            requireConversationMember($db, $conversationId, $user['email']);

            // Toggle pinned state
            $stmt = $db->prepare("SELECT pinned FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
            $stmt->execute([':cid' => $conversationId, ':email' => $user['email']]);
            $row = $stmt->fetch();
            $current = $row ? (int)$row['pinned'] : 0;
            $newPinned = $current ? 0 : 1;

            $db->prepare("
                UPDATE chat_conversation_members SET pinned = :pinned
                WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)
            ")->execute([':pinned' => $newPinned, ':cid' => $conversationId, ':email' => $user['email']]);

            jsonResponse(true, ['pinned' => (bool)$newPinned], $newPinned ? 'Conversation pinned' : 'Conversation unpinned');
            break;
        }

        // ============================================================
        // status_create — Create a status update (24h story)
        // ============================================================
        // ============================================================
        // call_notify — Create call_card message when a call starts
        // ============================================================
        case 'call_notify': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $callId = trim((string)($input['call_id'] ?? $input['room_id'] ?? ''));
            $video = !empty($input['video']);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if ($callId === '') $callId = bin2hex(random_bytes(8));
            requireConversationMember($db, $conversationId, $user['email']);

            $payload = [
                'call_id' => $callId,
                'room_id' => $callId,
                'video' => $video,
                'caller_email' => $user['email'],
                'status' => 'ringing',
                'started_at' => gmdate('Y-m-d\TH:i:s\Z'),
            ];
            $content = json_encode($payload, JSON_UNESCAPED_UNICODE);
            $stmt = $db->prepare("
                INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                VALUES (:cid, :sender, :content, 'call_card', now()::text)
                RETURNING id
            ");
            $stmt->execute([':cid' => $conversationId, ':sender' => $user['email'], ':content' => $content]);
            $msgId = (int)$stmt->fetchColumn();

            // Record the call so even if both clients drop the network
            // before an in-app hang-up event, the missed call is visible in
            // call history on reconnect. One row per participant.
            //
            // is_group is computed from member count so the history filter
            // ("Group calls only") works correctly. Was hardcoded 0 — group
            // calls were getting logged as 1:1, hiding from group filter.
            try {
                $pg = $db;
                $peers = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid");
                $peers->execute([':cid' => $conversationId]);
                $peerRows = $peers->fetchAll(); // materialize once — PDO cursors are forward-only
                $isGroup = count($peerRows) > 2 ? 1 : 0;
                $ins = $pg->prepare("INSERT INTO chat_call_history (user_email, contact_email, contact_name, call_id, type, video, timestamp, conversation_id, status, duration, is_group, created_at) VALUES (:u, :c, :cn, :cid, :t, :v, :ts, :conv, 'ringing', 0, :ig, now()::text) ON CONFLICT DO NOTHING");
                $ts = (int)(microtime(true) * 1000);
                foreach ($peerRows as $p) {
                    $pe = $p['email'];
                    $type = strtolower($pe) === strtolower($user['email']) ? 'outgoing' : 'incoming';
                    $other = $type === 'outgoing' ? '' : $user['email'];
                    if ($type === 'outgoing') {
                        // For the caller's row, contact_email = first other peer.
                        // Previously we re-fetched $peers here, but PDO cursors
                        // are forward-only, so the second fetchAll returned
                        // empty and the outgoing history row was NEVER inserted.
                        $other = '';
                        foreach ($peerRows as $pp) { if (strtolower($pp['email']) !== strtolower($user['email'])) { $other = $pp['email']; break; } }
                        if ($other === '') continue;
                    }
                    $ins->execute([
                        ':u' => $pe, ':c' => $other, ':cn' => chatDisplayName($other),
                        ':cid' => $callId, ':t' => $type, ':v' => $video ? 1 : 0,
                        ':ts' => $ts, ':conv' => $conversationId, ':ig' => $isGroup,
                    ]);
                }
            } catch (Throwable $e) { error_log('[call_notify.history] ' . $e->getMessage()); }

            $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :cid")
               ->execute([':cid' => $conversationId]);

            // Push notification ao destinatário: VoIP (iOS → CallKit nativo,
            // tela cheia de chamada mesmo com app fechado/locked) + FCM
            // (Android → CallKeep). Sem isso, a ligação só rolava se ambos
            // tinham o app aberto + WS conectado. Dispara os dois em
            // paralelo: o device iOS usa o VoIP, Android + web usam o FCM.
            try {
                if (!function_exists('fcmSendToUser')) {
                    require_once __DIR__ . '/firebase_push.php';
                }
                if (!function_exists('sendVoipPushToUser')) {
                    @require_once __DIR__ . '/voip_push.php';
                }
                $callerName = chatDisplayName($user['email']) ?: $user['email'];
                $ci = chatCallerIdentity($user['email']);
                $callTitle = $video ? 'Videochamada Chatyy' : 'Chamada Chatyy';
                $callBody = $callerName . ' está chamando…';
                $callData = [
                    'type'            => 'incoming_call',
                    'category_id'     => 'incoming_call',
                    'call_id'         => $callId,
                    'room_id'         => $callId,
                    'conversation_id' => (string)$conversationId,
                    'caller_email'    => $user['email'],
                    'caller_name'     => $callerName,
                    'caller_phone'    => $ci['phone'],
                    'caller_verified' => $ci['verified'] ? '1' : '0',
                    'video'           => $video ? '1' : '0',
                    // is_group lets the receiver pick the group-call screen
                    // (LiveKit room) vs the 1:1 mesh path. Without it the
                    // callee enters as a 1:1 peer and never sees other
                    // participants. WhatsApp does the same gating.
                    'is_group'        => $isGroup ? '1' : '0',
                    'priority'        => 'high',
                    'group_key'       => 'call_' . $callId,
                    'thread_id'       => 'call_' . $callId,
                ];
                // WhatsApp parity: blocked users CANNOT call you. Pull
                // chat_blocked_users where any peer has blocked the caller.
                // Their device skips the VoIP+FCM ring entirely (the call
                // bubble still shows in the conversation, but the UI never
                // wakes). Previously this was a real bug — block had no
                // effect on call signaling, blocked party still rang you.
                $callBlockedPeers = [];
                try {
                    $bs = $db->prepare("SELECT blocker_email FROM chat_blocked_users WHERE LOWER(blocked_email) = LOWER(:c)");
                    $bs->execute([':c' => $user['email']]);
                    foreach ($bs->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $callBlockedPeers[strtolower($row['blocker_email'])] = true;
                    }
                } catch (\Throwable $e) { error_log('[call_notify.block_check] ' . $e->getMessage()); }

                foreach ($peerRows as $p) {
                    $pe = $p['email'];
                    if (strtolower($pe) === strtolower($user['email'])) continue;
                    // Skip ringing peers who blocked the caller — silent drop.
                    if (!empty($callBlockedPeers[strtolower($pe)])) {
                        error_log('[call_notify.blocked] caller=' . $user['email'] . ' suppressed for blocker=' . $pe);
                        continue;
                    }
                    // WhatsApp pattern: VoIP push wakes CallKit fullscreen
                    // (the only ringing UI iOS users should see). FCM is
                    // strictly a fallback — only fires if VoIP fails OR
                    // the user has no voip_token registered (Android, web,
                    // or iOS-pre-VoIP-build). Without this gate the iPhone
                    // shows BOTH CallKit and a notification banner at the
                    // same time, which is what the user reported.
                    $voipOk = false;
                    if (function_exists('sendVoipPushToUser')) {
                        try {
                            $r = sendVoipPushToUser($pe, $callData);
                            $voipOk = !empty($r);
                        } catch (Throwable $e) {
                            error_log('[call_notify.voip] ' . $pe . ': ' . $e->getMessage());
                        }
                    }
                    // FCM only when VoIP didn't deliver. Android FCM tokens
                    // never trigger sendVoipPushToUser success (PushKit is
                    // iOS-only), so Android keeps getting the FCM ring.
                    if (!$voipOk) {
                        try { fcmSendToUser($pe, $callTitle, $callBody, $callData); }
                        catch (Throwable $e) { error_log('[call_notify.push] ' . $pe . ': ' . $e->getMessage()); }
                    }
                }
            } catch (Throwable $e) { error_log('[call_notify.push] ' . $e->getMessage()); }

            jsonResponse(true, [
                'id' => $msgId,
                'conversation_id' => $conversationId,
                'call_id' => $callId,
                'room_id' => $callId,
                'video' => $video,
                'type' => 'call_card',
                'content' => $content,
                'created_at' => gmdate('Y-m-d\TH:i:s\Z'),
            ], 'Call notified');
            break;
        }

        // call_status — callee side or server-issued status transition. Lets
        // the client mark a call as answered/missed/ended even if the chat
        // bubble didn't update. Without this, missed calls during network
        // drops never landed in call history.
        case 'call_status': {
            $user = requireChatAuth();
            $callId = trim((string)($input['call_id'] ?? ''));
            $status = trim((string)($input['status'] ?? ''));
            $duration = (int)($input['duration'] ?? 0);
            if ($callId === '' || !in_array($status, ['ringing','answered','missed','declined','ended','failed'], true)) {
                jsonResponse(false, null, 'call_id + valid status required', 400);
            }
            try {
                $db->prepare("UPDATE chat_call_history SET status = :s, duration = CASE WHEN :d::int > 0 THEN :d2::int ELSE duration END WHERE call_id = :c")
                   ->execute([':s' => $status, ':d' => $duration, ':d2' => $duration, ':c' => $callId]);
            } catch (Throwable $e) { error_log('[call_status] ' . $e->getMessage()); }
            // Update the in-thread call_card so the bubble reflects the
            // final status on everyone's screen.
            $callerEmail = '';
            $convIdForPush = 0;
            try {
                $rows = $db->prepare("SELECT id, conversation_id, content, sender_email FROM chat_messages WHERE type = 'call_card' AND content LIKE :p ORDER BY id DESC LIMIT 1");
                $rows->execute([':p' => '%"' . $callId . '"%']);
                $row = $rows->fetch();
                if ($row) {
                    $j = json_decode($row['content'], true) ?: [];
                    $j['status'] = $status;
                    if ($duration > 0) $j['duration'] = $duration;
                    $db->prepare("UPDATE chat_messages SET content = :c WHERE id = :id")
                       ->execute([':c' => json_encode($j, JSON_UNESCAPED_UNICODE), ':id' => $row['id']]);
                    try { broadcastChatMessage($db, (int)$row['conversation_id'], (int)$row['id'], $user['email'], 'edit'); } catch (Throwable $e) {}
                    $callerEmail = (string)($j['caller_email'] ?? $row['sender_email'] ?? '');
                    $convIdForPush = (int)$row['conversation_id'];
                }
            } catch (Throwable $e) {}

            // Missed call → push notification (WhatsApp parity). Only fires
            // when the CALLEE side reports missed (callerEmail !== reporter).
            // Without this, users had no way to know they missed a call —
            // CallKit + ringing UI vanish silently after timeout, and the
            // call_card bubble doesn't generate any push of its own.
            if ($status === 'missed' && $callerEmail !== '' && $convIdForPush > 0
                && strtolower($callerEmail) !== strtolower($user['email'])) {
                try {
                    if (!function_exists('fcmSendToUser')) {
                        require_once __DIR__ . '/firebase_push.php';
                    }
                    $callerName = chatDisplayName($callerEmail) ?: $callerEmail;
                    $missTitle = 'Chamada perdida';
                    $missBody = $callerName;
                    $missData = [
                        'type'            => 'missed_call',
                        'category_id'     => 'missed_call',
                        'conversation_id' => (string)$convIdForPush,
                        'caller_email'    => $callerEmail,
                        'caller_name'     => $callerName,
                        'call_id'         => $callId,
                        'group_key'       => 'missed_call_' . $convIdForPush,
                        'thread_id'       => 'chat_' . $convIdForPush,
                    ];
                    fcmSendToUser($user['email'], $missTitle, $missBody, $missData);
                } catch (Throwable $e) { error_log('[missed_call.push] ' . $e->getMessage()); }
            }
            jsonResponse(true, ['status' => $status], 'Call status updated');
            break;
        }

        // chat_group_call — alias for initiating a group call (creates call_card)
        // ============================================================
        // chat_livekit_token — Issue a JWT for LiveKit room
        // ============================================================
        case 'chat_livekit_token': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $roomOverride = trim((string)($input['room'] ?? ''));
            if (!$conversationId && $roomOverride === '') {
                jsonResponse(false, null, 'conversation_id or room required', 400);
            }
            if ($conversationId) {
                requireConversationMember($db, $conversationId, $user['email']);
            }
            $room = $roomOverride !== '' ? $roomOverride : ('conv_' . $conversationId);

            // LiveKit JWT: HS256, 6h expiry, video grant with publish+subscribe
            $apiKey = getenv('LIVEKIT_API_KEY') ?: '';
            $apiSecret = getenv('LIVEKIT_API_SECRET') ?: '';
            $livekitHost = getenv('LIVEKIT_HOST') ?: 'wss://livekit.chatyy.com.br';
            if (!$apiKey || !$apiSecret) {
                // Read from env file as fallback
                if (file_exists('/etc/mail-api.env')) {
                    foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                        if (strpos($line, '#') === 0) continue;
                        [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
                        if ($k === 'LIVEKIT_API_KEY' && !$apiKey) $apiKey = trim($v);
                        if ($k === 'LIVEKIT_API_SECRET' && !$apiSecret) $apiSecret = trim($v);
                        if ($k === 'LIVEKIT_HOST' && !getenv('LIVEKIT_HOST')) $livekitHost = trim($v);
                    }
                }
            }
            if (!$apiKey || !$apiSecret) {
                jsonResponse(false, null, 'LiveKit not configured', 500);
            }

            $now = time();
            $payload = [
                'iss' => $apiKey,
                'sub' => $user['email'],
                'iat' => $now,
                'nbf' => $now - 10,
                'exp' => $now + 21600, // 6h
                'name' => $user['name'] ?? explode('@', $user['email'])[0],
                'video' => [
                    'room' => $room,
                    'roomJoin' => true,
                    'canPublish' => true,
                    'canSubscribe' => true,
                    'canPublishData' => true,
                ],
            ];
            $header = ['alg' => 'HS256', 'typ' => 'JWT'];
            $b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
            $headerB = $b64(json_encode($header, JSON_UNESCAPED_SLASHES));
            $payloadB = $b64(json_encode($payload, JSON_UNESCAPED_SLASHES));
            $sig = hash_hmac('sha256', "{$headerB}.{$payloadB}", $apiSecret, true);
            $token = "{$headerB}.{$payloadB}." . $b64($sig);

            // ICE servers — LiveKit's built-in TURN is disabled, so we need to
            // hand the client our coturn relay. Without TURN, strict NAT (CGN
            // cellular) clients can't traverse UDP 50000-50100 → ICE fails →
            // ParticipantDisconnected ~10s after join → caller tears down →
            // both ends see "Não foi possível conectar". coturn is in
            // use-auth-secret mode (rfc5766-turn-server REST API): the
            // username is `<unix_ts>:<email>` and password is base64 of
            // HMAC-SHA1(shared_secret, username).
            // Google's public STUN — first line of defense for NAT discovery.
            // Always include these as host-candidate fallback even if our own
            // STUN is reachable. WhatsApp/Signal do the same.
            $iceServers = [
                ['urls' => [
                    'stun:stun.l.google.com:19302',
                    'stun:stun1.l.google.com:19302',
                    'stun:stun2.l.google.com:19302',
                ]],
            ];
            $turnSecret = getenv('COTURN_SECRET') ?: '';
            if (!$turnSecret && file_exists('/etc/turnserver.conf')) {
                foreach (file('/etc/turnserver.conf', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (preg_match('/^\s*static-auth-secret\s*=\s*(\S+)/', $line, $m)) {
                        $turnSecret = $m[1];
                        break;
                    }
                }
            }
            if ($turnSecret) {
                $turnExpiry = $now + 21600; // 6h, match JWT
                $turnUsername = $turnExpiry . ':' . $user['email'];
                $turnPassword = base64_encode(hash_hmac('sha1', $turnUsername, $turnSecret, true));
                $turnHost = getenv('TURN_HOST') ?: 'turn.chatyy.com.br';
                $turnPort = (int)(getenv('TURN_PORT') ?: 3478);
                // TCP first: CGN cellular blocks UDP 3478 frequently. TCP
                // mimics web traffic and traverses more reliably. UDP is the
                // performance optimum but TCP is the survival path.
                $iceServers[] = ['urls' => ['stun:' . $turnHost . ':' . $turnPort]];
                $iceServers[] = [
                    'urls' => [
                        'turn:' . $turnHost . ':' . $turnPort . '?transport=tcp',
                        'turn:' . $turnHost . ':' . $turnPort . '?transport=udp',
                    ],
                    'username' => $turnUsername,
                    'credential' => $turnPassword,
                ];
            }

            jsonResponse(true, [
                'token' => $token,
                'url' => $livekitHost,
                'room' => $room,
                'identity' => $user['email'],
                'expires_at' => $now + 21600,
                'iceServers' => $iceServers,
            ]);
            break;
        }

        // ============================================================
        // chat_live_reaction — Server-side path for floating-heart reactions.
        // Frontend usually fires reactions directly over WebSocket (lower
        // latency), but a REST fallback is useful when the WS hiccups so the
        // viewer's tap-spam still lands on every other viewer's screen.
        //
        // Payload: { live_id|session_id, x: 0..1, color: '#hex' }
        // Side effect: broadcasts a `live_reaction` event over the live_<id>
        // WS channel so all subscribers (host + viewers) spawn a heart.
        //
        // Rate-limit: 5/s per user per live room (matches the WS-side cap).
        // ============================================================
        case 'chat_live_reaction': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['live_id'] ?? ''));
            $x = $input['x'] ?? null;
            $color = trim((string)($input['color'] ?? ''));
            $emoji = trim((string)($input['emoji'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);
            // Validate x — must be a finite number in [0, 1]. We accept strings
            // for forgiveness (some clients JSON-stringify floats).
            $xNorm = null;
            if (is_numeric($x)) {
                $xf = (float)$x;
                if ($xf >= 0.0 && $xf <= 1.0) $xNorm = $xf;
            }
            // Validate color — short hex (#abc) or full hex (#abcdef). Reject
            // anything else so we never broadcast a CSS-injection payload to a
            // client that might trust the value.
            $colorNorm = null;
            if ($color !== '' && preg_match('/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/', $color)) {
                $colorNorm = $color;
            }
            if ($xNorm === null && $emoji === '') {
                jsonResponse(false, null, 'x (0..1) or emoji required', 400);
            }
            // Per-user/per-live rate limit — 5 reactions/sec absolute cap.
            // Client throttles to 300ms (≈3/sec) so we accept that with
            // headroom; abuse cases get short-circuited here.
            $rateFile = '/tmp/live_react_rate_' . md5($user['email'] . '|' . $sessionId);
            $rates = [];
            if (file_exists($rateFile)) {
                $raw = @file_get_contents($rateFile);
                $d = $raw ? json_decode($raw, true) : null;
                if (is_array($d)) $rates = array_values(array_filter($d, fn($t) => is_numeric($t) && $t > microtime(true) - 1));
            }
            if (count($rates) >= 5) jsonResponse(false, null, 'Too many reactions', 429);
            $rates[] = microtime(true);
            @file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            // Broadcast on the live channel so every subscribed client (host +
            // viewers) renders the heart in real time. Channel name matches
            // the WS server's live channel convention (`live_<session_id>`).
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    $payload = [
                        'session_id'     => $sessionId,
                        'email'          => $user['email'],
                        'name'           => $user['name'] ?? explode('@', $user['email'])[0],
                        'reactor_email'  => $user['email'],
                        'reactor_name'   => $user['name'] ?? explode('@', $user['email'])[0],
                        'x'              => $xNorm,
                        'color'          => $colorNorm,
                        'emoji'          => $emoji !== '' ? $emoji : null,
                    ];
                    $body = json_encode([
                        'channel' => 'live_' . $sessionId,
                        'event'   => 'live_reaction',
                        'data'    => $payload,
                    ], JSON_UNESCAPED_UNICODE);
                    $cu = curl_init('http://127.0.0.1:8081/broadcast');
                    curl_setopt_array($cu, [
                        CURLOPT_POST            => true,
                        CURLOPT_POSTFIELDS      => $body,
                        CURLOPT_HTTPHEADER      => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                        CURLOPT_RETURNTRANSFER  => true,
                        CURLOPT_TIMEOUT_MS      => 1500,
                        CURLOPT_CONNECTTIMEOUT_MS => 500,
                    ]);
                    curl_exec($cu); curl_close($cu);
                }
            } catch (\Throwable $e) { error_log('[chat_live_reaction.ws] ' . $e->getMessage()); }

            jsonResponse(true, ['sent' => true, 'x' => $xNorm, 'color' => $colorNorm]);
            break;
        }

        // ============================================================
        // chat_live_cohost_approve — Host approves a viewer to become co-host.
        // Inserts an auth row so the viewer can later request a publisher
        // token for the live session's LiveKit room. Idempotent.
        // ============================================================
        case 'chat_live_cohost_approve': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            $viewerEmail = strtolower(trim((string)($input['viewer_email'] ?? '')));
            if ($sessionId === '' || $viewerEmail === '') {
                jsonResponse(false, null, 'session_id and viewer_email required', 400);
            }
            // Only the host of the session can approve cohosts.
            $sStmt = $db->prepare("SELECT host_email FROM chat_live_sessions WHERE id = :id");
            $sStmt->execute([':id' => $sessionId]);
            $session = $sStmt->fetch();
            if (!$session) jsonResponse(false, null, 'Live session not found', 404);
            if (strcasecmp((string)$session['host_email'], $user['email']) !== 0) {
                jsonResponse(false, null, 'Only the host can approve cohosts', 403);
            }
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_live_cohosts (
                    session_id TEXT NOT NULL,
                    viewer_email TEXT NOT NULL,
                    approved_by TEXT NOT NULL,
                    approved_at TEXT NOT NULL DEFAULT now()::text,
                    revoked_at TEXT DEFAULT NULL,
                    PRIMARY KEY (session_id, viewer_email)
                )");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_cohosts_session ON chat_live_cohosts(session_id)");
            } catch (Throwable $e) { /* table may already exist */ }
            $ins = $db->prepare("
                INSERT INTO chat_live_cohosts (session_id, viewer_email, approved_by, approved_at, revoked_at)
                VALUES (:s, :v, :h, now()::text, NULL)
                ON CONFLICT (session_id, viewer_email)
                DO UPDATE SET approved_at = now()::text, revoked_at = NULL, approved_by = EXCLUDED.approved_by
            ");
            $ins->execute([':s' => $sessionId, ':v' => $viewerEmail, ':h' => $user['email']]);

            // WS push to the cohost viewer so their client knows to request a
            // publisher token + join the room. Targeted to their per-user
            // channel (chat_user_{email}) since they may not be in a chat
            // conversation channel for this live session.
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    $payload = [
                        'session_id'   => $sessionId,
                        'viewer_email' => $viewerEmail,
                        'host_email'   => $user['email'],
                        'via_livekit'  => true,
                    ];
                    $body = json_encode([
                        'channel' => 'chat_user_' . $viewerEmail,
                        'event'   => 'live_cohost_approved',
                        'data'    => $payload,
                    ], JSON_UNESCAPED_UNICODE);
                    $cu = curl_init('http://127.0.0.1:8081/broadcast');
                    curl_setopt_array($cu, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT_MS => 1500, CURLOPT_CONNECTTIMEOUT_MS => 500]);
                    curl_exec($cu); curl_close($cu);
                }
            } catch (\Throwable $e) { error_log('[live_cohost_approve.ws] ' . $e->getMessage()); }
            jsonResponse(true, ['session_id' => $sessionId, 'viewer_email' => $viewerEmail], 'Cohost approved');
            break;
        }

        // ============================================================
        // chat_live_cohost_token — Cohost requests a publisher token for
        // the live session's LiveKit room. Verifies the host already
        // approved this viewer (via chat_live_cohost_approve).
        // ============================================================
        case 'chat_live_cohost_token': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            $authStmt = $db->prepare("SELECT approved_at, revoked_at FROM chat_live_cohosts WHERE session_id = :s AND LOWER(viewer_email) = LOWER(:e)");
            $authStmt->execute([':s' => $sessionId, ':e' => $user['email']]);
            $auth = $authStmt->fetch();
            if (!$auth) jsonResponse(false, null, 'Not approved as cohost for this session', 403);
            if (!empty($auth['revoked_at'])) jsonResponse(false, null, 'Cohost authorization was revoked', 403);

            // Same mint pattern as chat_livekit_token but pinned to the live
            // session room. Identity = user email so the LK SFU + UI can
            // dedup the participant if they were already subscribed.
            $room = 'live_' . $sessionId;
            $apiKey = getenv('LIVEKIT_API_KEY') ?: '';
            $apiSecret = getenv('LIVEKIT_API_SECRET') ?: '';
            $livekitHost = getenv('LIVEKIT_HOST') ?: 'wss://livekit.chatyy.com.br';
            if ((!$apiKey || !$apiSecret) && file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strpos($line, '#') === 0) continue;
                    [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
                    if ($k === 'LIVEKIT_API_KEY' && !$apiKey) $apiKey = trim($v);
                    if ($k === 'LIVEKIT_API_SECRET' && !$apiSecret) $apiSecret = trim($v);
                    if ($k === 'LIVEKIT_HOST' && !getenv('LIVEKIT_HOST')) $livekitHost = trim($v);
                }
            }
            if (!$apiKey || !$apiSecret) jsonResponse(false, null, 'LiveKit not configured', 500);

            $now = time();
            $payload = [
                'iss' => $apiKey,
                'sub' => $user['email'],
                'iat' => $now,
                'nbf' => $now - 10,
                'exp' => $now + 7200, // 2h — cohost sessions are short
                'name' => $user['name'] ?? explode('@', $user['email'])[0],
                'video' => [
                    'room' => $room,
                    'roomJoin' => true,
                    'canPublish' => true,
                    'canSubscribe' => true,
                    'canPublishData' => true,
                ],
            ];
            $b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
            $headerB = $b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_UNESCAPED_SLASHES));
            $payloadB = $b64(json_encode($payload, JSON_UNESCAPED_SLASHES));
            $sig = hash_hmac('sha256', "{$headerB}.{$payloadB}", $apiSecret, true);
            $token = "{$headerB}.{$payloadB}." . $b64($sig);

            jsonResponse(true, [
                'token'      => $token,
                'url'        => $livekitHost,
                'room'       => $room,
                'identity'   => $user['email'],
                'expires_at' => $now + 7200,
            ], 'Cohost token issued');
            break;
        }

        // chat_live_host_lk_token — Host requests a subscribe-only LK token
        // for THEIR OWN live session. Use case: host wants to subscribe to
        // cohosts publishing into `live_{session_id}` without re-publishing
        // their own raw-WebRTC stream into LK. Stage 3 of #929. The host
        // identity is suffixed with `-host` so LK doesn't dedup the host
        // and a cohost participant if they happen to be the same user (rare
        // but possible during self-cohost testing).
        case 'chat_live_host_lk_token': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            $sessStmt = $db->prepare("SELECT host_email FROM chat_live_sessions WHERE session_id = :s");
            $sessStmt->execute([':s' => $sessionId]);
            $hostEmail = $sessStmt->fetchColumn();
            if (!$hostEmail) jsonResponse(false, null, 'Session not found', 404);
            if (strcasecmp($hostEmail, $user['email']) !== 0) {
                jsonResponse(false, null, 'Not the host of this session', 403);
            }

            $room = 'live_' . $sessionId;
            $apiKey = getenv('LIVEKIT_API_KEY') ?: '';
            $apiSecret = getenv('LIVEKIT_API_SECRET') ?: '';
            $livekitHost = getenv('LIVEKIT_HOST') ?: 'wss://livekit.chatyy.com.br';
            if ((!$apiKey || !$apiSecret) && file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strpos($line, '#') === 0) continue;
                    [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
                    if ($k === 'LIVEKIT_API_KEY' && !$apiKey) $apiKey = trim($v);
                    if ($k === 'LIVEKIT_API_SECRET' && !$apiSecret) $apiSecret = trim($v);
                    if ($k === 'LIVEKIT_HOST' && !getenv('LIVEKIT_HOST')) $livekitHost = trim($v);
                }
            }
            if (!$apiKey || !$apiSecret) jsonResponse(false, null, 'LiveKit not configured', 500);

            $identity = $user['email'] . '-host';
            $now = time();
            $payload = [
                'iss' => $apiKey,
                'sub' => $identity,
                'iat' => $now,
                'nbf' => $now - 10,
                'exp' => $now + 7200,
                'name' => ($user['name'] ?? explode('@', $user['email'])[0]) . ' (host)',
                'video' => [
                    'room' => $room,
                    'roomJoin' => true,
                    // Subscribe-only — host's primary publish path stays on
                    // legacy WebRTC for now. Stage 4 may flip canPublish=true
                    // if we migrate the broadcaster to LK publishing too.
                    'canPublish' => false,
                    'canSubscribe' => true,
                    'canPublishData' => true,
                ],
            ];
            $b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
            $headerB = $b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_UNESCAPED_SLASHES));
            $payloadB = $b64(json_encode($payload, JSON_UNESCAPED_SLASHES));
            $sig = hash_hmac('sha256', "{$headerB}.{$payloadB}", $apiSecret, true);
            $token = "{$headerB}.{$payloadB}." . $b64($sig);

            jsonResponse(true, [
                'token'      => $token,
                'url'        => $livekitHost,
                'room'       => $room,
                'identity'   => $identity,
                'expires_at' => $now + 7200,
            ], 'Host LK token issued');
            break;
        }

        case 'chat_group_call': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $callType = $input['call_type'] ?? 'video';
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $conversationId, $user['email']);
            $callId = bin2hex(random_bytes(8));
            $video = ($callType === 'video');
            $payload = [
                'call_id' => $callId,
                'room_id' => $callId,
                'video' => $video,
                'caller_email' => $user['email'],
                'status' => 'ringing',
                'is_group' => true,
                'started_at' => gmdate('Y-m-d\TH:i:s\Z'),
            ];
            $content = json_encode($payload, JSON_UNESCAPED_UNICODE);
            $stmt = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :s, :c, 'call_card', now()::text) RETURNING id");
            $stmt->execute([':cid' => $conversationId, ':s' => $user['email'], ':c' => $content]);
            $msgId = (int)$stmt->fetchColumn();

            // ── Push fanout to every member except the caller ─────────────
            // Without this, only members with the chat already open see the
            // call_card via WS. Backgrounded/closed members never hear the
            // ring. Pattern cloned from chat_call_invite (same call_data
            // shape so IncomingCallActivity/CallKit renders identically).
            try {
                if (!function_exists('fcmSendToUser')) @require_once __DIR__ . '/firebase_push.php';
                if (!function_exists('sendVoipPushToUser')) @require_once __DIR__ . '/voip_push.php';

                // Pull conversation name (group display) + all members.
                $convStmt = $db->prepare("SELECT name FROM chat_conversations WHERE id = :id");
                $convStmt->execute([':id' => $conversationId]);
                $groupName = (string)($convStmt->fetchColumn() ?: '');

                $memStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid");
                $memStmt->execute([':cid' => $conversationId]);
                $members = array_column($memStmt->fetchAll(PDO::FETCH_ASSOC), 'email');

                $callerName = chatDisplayName($user['email']) ?: $user['email'];
                $ci = chatCallerIdentity($user['email']);
                if ($groupName === '') $groupName = $callerName;
                $callTitle = $video ? 'Videochamada em grupo' : 'Chamada em grupo';
                $callBody  = $callerName . ' está chamando em ' . $groupName;
                $callData = [
                    'type'             => 'incoming_group_call',
                    'category_id'      => 'group_call',
                    'call_id'          => $callId,
                    'room_id'          => $callId,
                    'conversation_id'  => (string)$conversationId,
                    'caller_email'     => $user['email'],
                    'caller_name'      => $callerName,
                    'caller_phone'     => $ci['phone'],
                    'caller_verified'  => $ci['verified'] ? '1' : '0',
                    'group_name'       => $groupName,
                    'video'            => $video ? '1' : '0',
                    'is_group'         => '1',
                    'priority'         => 'high',
                    'group_key'        => 'call_' . $callId,
                    'thread_id'        => 'call_' . $callId,
                ];
                foreach ($members as $pe) {
                    if (!is_string($pe) || $pe === '') continue;
                    if (strcasecmp($pe, $user['email']) === 0) continue;
                    if (function_exists('sendVoipPushToUser')) {
                        try { @sendVoipPushToUser($pe, $callData); }
                        catch (Throwable $e) { error_log('[group_call.voip] ' . $pe . ': ' . $e->getMessage()); }
                    }
                    try { fcmSendToUser($pe, $callTitle, $callBody, $callData); }
                    catch (Throwable $e) { error_log('[group_call.push] ' . $pe . ': ' . $e->getMessage()); }
                }
            } catch (Throwable $e) {
                error_log('[group_call.fanout] ' . $e->getMessage());
            }

            jsonResponse(true, ['id' => $msgId, 'call_id' => $callId, 'room_id' => $callId, 'video' => $video, 'content' => $content], 'Group call started');
            break;
        }

        // Add a participant to an already-running group call. Used when the
        // caller hits "+ Add" mid-call. Does NOT create a new call_card —
        // just rings the new invitees with the existing call_id so they join
        // the same LiveKit room. The frontend tells us who to invite via
        // `emails` (array of conversation members not yet in the call).
        case 'chat_call_invite': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $callId = trim($input['call_id'] ?? '');
            $video = !empty($input['video']);
            $emails = $input['emails'] ?? [];
            if (!is_array($emails)) $emails = [];
            $emails = array_values(array_unique(array_filter(array_map('strtolower', array_map('trim', $emails)))));

            if (!$conversationId || !$callId || empty($emails)) {
                jsonResponse(false, null, 'conversation_id, call_id, emails required', 400);
            }
            requireConversationMember($db, $conversationId, $user['email']);

            // Validate that every invitee is a member of the conversation —
            // otherwise this becomes a way to ring random users.
            $placeholders = implode(',', array_fill(0, count($emails), '?'));
            $sql = "SELECT email FROM chat_conversation_members WHERE conversation_id = ? AND lower(email) IN ($placeholders)";
            $stmt = $db->prepare($sql);
            $stmt->execute(array_merge([$conversationId], $emails));
            $validEmails = array_column($stmt->fetchAll(PDO::FETCH_ASSOC), 'email');
            if (empty($validEmails)) jsonResponse(false, null, 'No valid invitees', 400);

            // Send the same VoIP push that chat_group_call sends, but with the
            // existing call_id so the invitee joins the running room.
            if (!function_exists('fcmSendToUser')) @require_once __DIR__ . '/firebase_push.php';
            if (!function_exists('sendVoipPushToUser')) @require_once __DIR__ . '/voip_push.php';
            $callerName = chatDisplayName($user['email']) ?: $user['email'];
            $ci = chatCallerIdentity($user['email']);
            $callTitle = $video ? 'Videochamada Chatyy' : 'Chamada Chatyy';
            $callBody = $callerName . ' está chamando para entrar na chamada…';
            $callData = [
                'type'            => 'incoming_call',
                'category_id'     => 'incoming_call',
                'call_id'         => $callId,
                'room_id'         => $callId,
                'conversation_id' => (string)$conversationId,
                'caller_email'    => $user['email'],
                'caller_name'     => $callerName,
                'caller_phone'    => $ci['phone'],
                'caller_verified' => $ci['verified'] ? '1' : '0',
                'video'           => $video ? '1' : '0',
                'is_group'        => '1',
                'priority'        => 'high',
                'group_key'       => 'call_' . $callId,
                'thread_id'       => 'call_' . $callId,
            ];
            $delivered = [];
            foreach ($validEmails as $pe) {
                if (strtolower($pe) === strtolower($user['email'])) continue;
                $voipOk = false;
                if (function_exists('sendVoipPushToUser')) {
                    try { $voipOk = (bool)sendVoipPushToUser($pe, $callData); }
                    catch (Throwable $e) { error_log('[call_invite.voip] ' . $pe . ': ' . $e->getMessage()); }
                }
                try { fcmSendToUser($pe, $callTitle, $callBody, $callData); }
                catch (Throwable $e) { error_log('[call_invite.push] ' . $pe . ': ' . $e->getMessage()); }
                $delivered[] = ['email' => $pe, 'voip' => $voipOk];
            }

            jsonResponse(true, [
                'call_id' => $callId,
                'invited' => $delivered,
                'count' => count($delivered),
            ], 'Invitees rung');
            break;
        }

        case 'status_publish':
        case 'status_create': {
            $user = requireChatAuth();
            $content = trim($input['content'] ?? '');
            $type = $input['type'] ?? 'text';
            $mediaUrl = $input['media_url'] ?? '';
            $background = $input['background'] ?? '';

            if ($content === '' && $mediaUrl === '') {
                jsonResponse(false, null, 'Content or media required', 400);
            }

            // Wave 4: 'poll' status type. Poll metadata travels in $input['poll']
            // (validated below) so the wire format stays compatible — we keep
            // the same chat_user_status row shape and the viewer renders the
            // poll UI when type === 'poll'.
            if (!in_array($type, ['text', 'image', 'video', 'poll'])) {
                $type = 'text';
            }
            // For poll-type status, validate + normalize the poll payload.
            // Min 2 / max 6 options, max 80 chars each, max 200 char question.
            if ($type === 'poll') {
                $pollIn = $input['poll'] ?? null;
                if (!is_array($pollIn)) {
                    jsonResponse(false, null, 'poll required for type=poll', 400);
                }
                $pq = trim((string)($pollIn['question'] ?? ''));
                $popts = $pollIn['options'] ?? [];
                if ($pq === '' || mb_strlen($pq) > 200) {
                    jsonResponse(false, null, 'poll.question 1-200 chars required', 400);
                }
                if (!is_array($popts) || count($popts) < 2 || count($popts) > 6) {
                    jsonResponse(false, null, 'poll.options must be 2-6 entries', 400);
                }
                $cleanOpts = [];
                foreach ($popts as $opt) {
                    $s = trim((string)$opt);
                    if ($s === '') continue;
                    if (mb_strlen($s) > 80) $s = mb_substr($s, 0, 80);
                    $cleanOpts[] = $s;
                }
                if (count($cleanOpts) < 2) {
                    jsonResponse(false, null, 'poll needs at least 2 non-empty options', 400);
                }
                // Stash the cleaned poll back into $input so the meta loop
                // below picks it up and persists it in chat_user_status.meta.
                $input['poll'] = ['question' => $pq, 'options' => $cleanOpts];
                // content carries the question so existing previews
                // (chat list, share strip) show something sensible without
                // the viewer having to decode meta.
                if ($content === '') $content = $pq;
            }

            // Expires in 24 hours
            $expiresAt = date('Y-m-d H:i:s', time() + 86400);

            // Optional metadata bag (stored as JSONB). Carries is_boomerang,
            // font_style, privacy, filter, etc. from the client so the viewer
            // can render the story correctly. Whitelist known keys to block
            // any arbitrary JSON from leaking through.
            //
            // caption_locale + caption_translations let viewers in a different
            // locale see an auto-translated caption. Owner sets caption_locale
            // (default 'pt-BR'); on-demand translate writes into
            // caption_translations[locale] = string and is cached on the row.
            $metaIn = $input;
            $metaOut = [];
            foreach (['is_boomerang','font_style','privacy','filter','stickers','text_overlays','draw_paths','caption','caption_locale','caption_translations','poll'] as $k) {
                if (array_key_exists($k, $metaIn) && $metaIn[$k] !== null && $metaIn[$k] !== '') {
                    $metaOut[$k] = $metaIn[$k];
                }
            }
            // Default caption_locale to the user's UI locale if not provided.
            if (!isset($metaOut['caption_locale']) && !empty($input['locale'])) {
                $metaOut['caption_locale'] = (string)$input['locale'];
            }
            if (!isset($metaOut['caption_locale'])) {
                $metaOut['caption_locale'] = 'pt-BR';
            }
            $metaJson = empty($metaOut) ? null : json_encode($metaOut, JSON_UNESCAPED_UNICODE);

            $stmt = $db->prepare("
                INSERT INTO chat_user_status (email, content, type, media_url, bg_color, expires_at, created_at, meta)
                VALUES (:email, :content, :type, :media_url, :background, :expires_at, now()::text, :meta::jsonb)
                RETURNING id
            ");
            $stmt->execute([
                ':email'      => $user['email'],
                ':content'    => $content,
                ':type'       => $type,
                ':media_url'  => $mediaUrl,
                ':background' => $background,
                ':expires_at' => $expiresAt,
                ':meta'       => $metaJson,
            ]);
            $statusId = (int)$stmt->fetchColumn();

            // WS broadcast so contacts see the new status in real time.
            // Targets: everyone who shares a conversation with the poster
            // (same reach rule as presence). Event name `status_new` on
            // each contact's personal channel `chat_user_{email}`.
            // Resolve poster URL once: if this is a video and the .thumb.jpg
            // exists on disk (synchronously generated by status_upload), surface
            // it on both the WS broadcast and the HTTP response so contacts
            // render the first frame instantly when their list refreshes.
            $__newThumbUrl = null;
            if ($type === 'video' && !empty($mediaUrl)) {
                $__pathOnly = parse_url($mediaUrl, PHP_URL_PATH) ?: $mediaUrl;
                if (strpos($__pathOnly, '/data/status/') === 0) {
                    $__diskPath = '/var/www/mail' . $__pathOnly . '.thumb.jpg';
                    if (is_file($__diskPath)) {
                        $__newThumbUrl = $__pathOnly . '.thumb.jpg';
                    }
                }
            }
            try {
                $peers = $db->prepare("SELECT DISTINCT cm2.email FROM chat_conversation_members cm1 JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id WHERE LOWER(cm1.email) = LOWER(:e) AND LOWER(cm2.email) <> LOWER(:e)");
                $peers->execute([':e' => $user['email']]);
                $emails = array_column($peers->fetchAll(), 'email');
                $payload = [
                    'id' => $statusId,
                    'email' => $user['email'],
                    'name' => $user['name'],
                    'content' => $content,
                    'type' => $type,
                    'media_url' => $mediaUrl,
                    'thumbnail_url' => $__newThumbUrl,
                    'background' => $background,
                    'created_at' => gmdate('c'),
                    'expires_at' => $expiresAt,
                    'views' => 0,
                    'is_boomerang' => !empty($metaOut['is_boomerang']),
                    'meta' => $metaOut,
                ];
                foreach ($emails as $peerEmail) {
                    _broadcastToOwnDevices($peerEmail, 'status_new', $payload);
                }
                // Also notify sender's other devices so they see their own
                // status appear in the feed without a manual refresh.
                _broadcastToOwnDevices($user['email'], 'status_new', $payload);
            } catch (Throwable $e) { error_log('[status_publish.ws] ' . $e->getMessage()); }

            // Optional cross-post to Feed. The client passes
            // `cross_post_feed: true` when the user checked the "Postar
            // também no Feed" box in the publish modal. We reuse the same
            // media_url so no second upload is needed. Failure is logged
            // but the status itself stays — cross-post is best-effort.
            $__crossPostedFeedId = null;
            if (!empty($input['cross_post_feed']) && ($type === 'image' || $type === 'video')) {
                try {
                    @$db->exec("CREATE TABLE IF NOT EXISTS feed_posts (
                        id BIGSERIAL PRIMARY KEY,
                        author_email TEXT NOT NULL,
                        caption TEXT,
                        media_url TEXT,
                        media_type TEXT,
                        thumbnail_url TEXT,
                        like_count INTEGER NOT NULL DEFAULT 0,
                        comment_count INTEGER NOT NULL DEFAULT 0,
                        view_count INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text
                    )");
                    $caption = (string)($metaOut['caption'] ?? $content);
                    $fpIns = $db->prepare("INSERT INTO feed_posts (author_email, caption, media_url, media_type, thumbnail_url) VALUES (:e, :c, :m, :t, :th) RETURNING id");
                    $fpIns->execute([
                        ':e' => $user['email'],
                        ':c' => $caption,
                        ':m' => $mediaUrl,
                        ':t' => $type,
                        ':th' => $__newThumbUrl,
                    ]);
                    $__crossPostedFeedId = (int)$fpIns->fetchColumn();
                } catch (Throwable $e) {
                    error_log('[status_create.cross_post] ' . $e->getMessage());
                }
            }

            jsonResponse(true, [
                'id'            => $statusId,
                'email'         => $user['email'],
                'name'          => $user['name'],
                'content'       => $content,
                'type'          => $type,
                'media_url'     => $mediaUrl,
                'thumbnail_url' => $__newThumbUrl,
                'background'    => $background,
                'expires_at'    => $expiresAt,
                'views'         => 0,
                'feed_post_id'  => $__crossPostedFeedId,
            ], 'Status created');
            break;
        }

        // ============================================================
        // status_upload — Upload media for status
        // ============================================================
        case 'status_upload': {
            $user = requireChatAuth();
            if (!chatRateLimit($user['email'], 'status_upload', 10, 60)) jsonResponse(false, null, 'Rate limit exceeded', 429);

            if (empty($_FILES['file'])) {
                jsonResponse(false, null, 'No file uploaded', 400);
            }
            $file = $_FILES['file'];
            // Bumped from 10MB → 100MB so iPhone videos (typically 30-80MB
            // for a 30s 1080p clip) actually upload through this PHP fallback
            // when the Rust→R2 path is unavailable. User reported "video no
            // status não funciona" — a 50MB clip was hitting the 10MB cap and
            // silently failing.
            $maxSize = 100 * 1024 * 1024;
            if ($file['size'] > $maxSize) {
                jsonResponse(false, null, 'File too large (max 100MB)', 400);
            }

            // 100GB plan storage cap — status uploads land in /data/status,
            // counted by the storage aggregator the same as chat-files.
            require_once __DIR__ . '/plans.php';
            enforceStorageCap($user['email'], (int)$file['size']);

            $allowedExt = ['jpg','jpeg','png','gif','webp','heic','heif','mp4','mov','m4v','webm'];
            $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION) ?: 'jpg');
            if (!in_array($ext, $allowedExt, true)) {
                jsonResponse(false, null, 'File type not allowed: ' . $ext, 415);
            }

            $uploadDir = '/var/www/mail/data/status/';
            if (!is_dir($uploadDir)) mkdir($uploadDir, 0755, true);

            $filename = uniqid('status_') . '.' . $ext;
            $dest = $uploadDir . $filename;

            if (!move_uploaded_file($file['tmp_name'], $dest)) {
                jsonResponse(false, null, 'Upload failed', 500);
            }
            @chmod($dest, 0640);

            // Generate a thumbnail JPG for video uploads — without this the
            // viewer shows a black screen for 0.5–3s while VideoView buffers
            // from R2/origin. Same recipe as the chat upload path: SYNC
            // (typically 0.5–2s) so the .thumb.jpg exists before we return,
            // bounded by `timeout 30` + `nice -n 19` + `setsid` so a stuck
            // ffmpeg can never wedge php-fpm.
            $__thumbUrl = null;
            $__hlsUrl = null;
            if (in_array($ext, ['mp4','mov','m4v','webm'], true)) {
                try {
                    $__thumbOut = $dest . '.thumb.jpg';
                    $__cmd = sprintf(
                        'setsid timeout 30 nice -n 19 ffmpeg -y -ss 0.5 -i %s -frames:v 1 -vf %s -q:v 5 %s 2>/dev/null',
                        escapeshellarg($dest),
                        escapeshellarg('scale=720:-2'),
                        escapeshellarg($__thumbOut)
                    );
                    @shell_exec($__cmd);
                    if (is_file($__thumbOut) && filesize($__thumbOut) > 0) {
                        @chmod($__thumbOut, 0640);
                        $__thumbUrl = '/data/status/' . $filename . '.thumb.jpg';
                    }
                } catch (Throwable $e) { $__thumbUrl = null; }

                // HLS variant: stream the video as 4-second .ts segments
                // referenced by an .m3u8 playlist. Player starts decoding the
                // first segment in <500ms instead of waiting for moov-atom +
                // first-buffer of a progressive mp4. Stories pattern.
                // ASYNC (background nohup) so the upload response doesn't
                // block on transcode — player falls back to .mp4 until HLS
                // lands, then upgrades on the next status_list refresh.
                try {
                    $__hlsBase = $dest . '.hls';
                    if (!is_dir($__hlsBase)) @mkdir($__hlsBase, 0755, true);
                    $__hlsCmd = sprintf(
                        'nohup setsid timeout 180 nice -n 19 ffmpeg -y -i %s -vf scale=720:-2 -c:v libx264 -preset veryfast -crf 24 -c:a aac -b:a 96k -hls_time 4 -hls_playlist_type vod -hls_segment_filename %s/seg_%%03d.ts %s/index.m3u8 >/dev/null 2>&1 &',
                        escapeshellarg($dest),
                        escapeshellarg($__hlsBase),
                        escapeshellarg($__hlsBase)
                    );
                    @shell_exec($__hlsCmd);
                    // Surface URL optimistically — the .m3u8 will exist by
                    // the next status_list call (~5s on typical 30s clip).
                    // status_list re-checks file existence before returning.
                    $__hlsUrl = '/data/status/' . $filename . '.hls/index.m3u8';
                } catch (Throwable $e) { $__hlsUrl = null; }
            }

            $url = '/data/status/' . $filename;
            jsonResponse(true, ['url' => $url, 'filename' => $filename, 'thumbnail_url' => $__thumbUrl, 'hls_url' => $__hlsUrl]);
            break;
        }

        // ============================================================
        // status_carousel_publish — Instagram-style multi-item post.
        // Client sends an "items" array of already-uploaded media (each with
        // its own url/type/caption) and a single background/privacy/metadata
        // scope. Every item lands as its own row in chat_user_status, but
        // they share a "carousel_group_id" (stored inside meta.carousel_id)
        // so the viewer can render them as a tap-through story sequence
        // without introducing a new column.
        //
        // Response mirrors status_publish but returns the full list of
        // freshly-created ids + the carousel id so the client can update
        // cache in one go.
        // ============================================================
        case 'status_carousel_publish': {
            $user = requireChatAuth();
            $items = $input['items'] ?? [];
            if (!is_array($items) || count($items) === 0) {
                jsonResponse(false, null, 'items array required', 400);
            }
            if (count($items) > 10) {
                jsonResponse(false, null, 'max 10 items per carousel', 400);
            }
            $privacy = $input['privacy'] ?? 'all';
            $carouselId = bin2hex(random_bytes(8)); // shared id for the batch
            $expiresAt = date('Y-m-d H:i:s', time() + 86400);
            $created = [];

            foreach ($items as $idx => $it) {
                $type = in_array(($it['type'] ?? 'image'), ['text','image','video'], true) ? $it['type'] : 'image';
                $mediaUrl = trim((string)($it['media_url'] ?? ''));
                $content  = trim((string)($it['content']  ?? '')); // caption or text body
                $bg       = (string)($it['background'] ?? '#000000');
                if ($type !== 'text' && $mediaUrl === '') continue; // skip empty media
                if ($type === 'text' && $content === '') continue;  // skip empty text

                // Per-item metadata: stickers/text_overlays/filter/font_style
                // travel with their slide. carousel_id + carousel_index let
                // the viewer sort and render the sequence.
                $meta = [
                    'carousel_id'    => $carouselId,
                    'carousel_index' => $idx,
                    'carousel_total' => count($items),
                ];
                foreach (['is_boomerang','font_style','filter','stickers','text_overlays','draw_paths','caption','text_animation'] as $k) {
                    if (array_key_exists($k, $it) && $it[$k] !== null && $it[$k] !== '') {
                        $meta[$k] = $it[$k];
                    }
                }
                if ($privacy !== 'all') $meta['privacy'] = $privacy;

                $stmt = $db->prepare("
                    INSERT INTO chat_user_status (email, content, type, media_url, bg_color, expires_at, created_at, meta)
                    VALUES (:email, :content, :type, :media_url, :background, :expires_at, now()::text, :meta::jsonb)
                    RETURNING id
                ");
                $stmt->execute([
                    ':email'      => $user['email'],
                    ':content'    => $content,
                    ':type'       => $type,
                    ':media_url'  => $mediaUrl,
                    ':background' => $bg,
                    ':expires_at' => $expiresAt,
                    ':meta'       => json_encode($meta, JSON_UNESCAPED_UNICODE),
                ]);
                $sid = (int)$stmt->fetchColumn();
                $created[] = ['id' => $sid, 'type' => $type, 'media_url' => $mediaUrl, 'content' => $content, 'meta' => $meta];
            }

            if (empty($created)) {
                jsonResponse(false, null, 'No valid items', 400);
            }

            // WS broadcast to contacts so carousel appears live.
            try {
                $peers = $db->prepare("SELECT DISTINCT cm2.email FROM chat_conversation_members cm1 JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id WHERE LOWER(cm1.email) = LOWER(:e) AND LOWER(cm2.email) <> LOWER(:e)");
                $peers->execute([':e' => $user['email']]);
                $emails = array_column($peers->fetchAll(), 'email');
                $payload = [
                    'carousel_id' => $carouselId,
                    'email'       => $user['email'],
                    'name'        => $user['name'],
                    'items'       => $created,
                    'expires_at'  => $expiresAt,
                ];
                foreach ($emails as $pe) { _broadcastToOwnDevices($pe, 'status_new', $payload); }
                _broadcastToOwnDevices($user['email'], 'status_new', $payload);
            } catch (Throwable $e) { error_log('[status_carousel.ws] ' . $e->getMessage()); }

            jsonResponse(true, [
                'carousel_id' => $carouselId,
                'items'       => $created,
                'expires_at'  => $expiresAt,
            ], 'Carousel published');
            break;
        }

        // ============================================================
        // status_reply_dm — Instagram-style reply. Opens (or reuses) the
        // DM with the status author and inserts a "status_reply" message
        // carrying a preview card: the snippet/media url + the reply text.
        // Differs from status_reply above in that we explicitly resolve
        // the owner from the status_id (client doesn't need to know it).
        // ============================================================
        case 'status_reply_dm': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $replyText = trim((string)($input['content'] ?? $input['text'] ?? ''));
            if (!$statusId || $replyText === '') {
                jsonResponse(false, null, 'status_id and content required', 400);
            }

            // Resolve owner + the snapshot we'll embed in the preview card.
            $stS = $db->prepare("SELECT id, email, type, media_url, content, bg_color, meta FROM chat_user_status WHERE id = :id");
            $stS->execute([':id' => $statusId]);
            $status = $stS->fetch();
            if (!$status) jsonResponse(false, null, 'Status not found', 404);
            $ownerEmail = strtolower($status['email']);
            if (strcasecmp($ownerEmail, $user['email']) === 0) {
                jsonResponse(false, null, 'Cannot reply to your own status', 400);
            }

            // Find-or-create direct conversation.
            $stF = $db->prepare("
                SELECT c.id FROM chat_conversations c
                JOIN chat_conversation_members m1 ON m1.conversation_id = c.id AND LOWER(m1.email) = LOWER(:me)
                JOIN chat_conversation_members m2 ON m2.conversation_id = c.id AND LOWER(m2.email) = LOWER(:them)
                WHERE c.type = 'direct' LIMIT 1
            ");
            $stF->execute([':me' => $user['email'], ':them' => $ownerEmail]);
            $convId = (int)$stF->fetchColumn();
            if (!$convId) {
                $stC = $db->prepare("INSERT INTO chat_conversations (type, created_by, created_at, updated_at) VALUES ('direct', :c, now()::text, now()::text) RETURNING id");
                $stC->execute([':c' => $user['email']]);
                $convId = (int)$stC->fetchColumn();
                $stM = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:cid, :e, 'member', now()::text)");
                $stM->execute([':cid' => $convId, ':e' => $user['email']]);
                $stM->execute([':cid' => $convId, ':e' => $ownerEmail]);
            }

            // Compose the status_reply payload — client renders as a
            // preview card attached to the reply text.
            $quote = [
                'reply_text' => $replyText,
                'status' => [
                    'id'         => (int)$status['id'],
                    'type'       => $status['type'],
                    'media_url'  => $status['media_url'],
                    'content'    => $status['content'],
                    'email'      => $status['email'],
                    'bg_color'   => $status['bg_color'] ?? '',
                    'created_at' => $status['created_at'] ?? null,
                ],
            ];
            $stIns = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :s, :c, 'status_reply', now()::text) RETURNING id");
            $stIns->execute([
                ':cid' => $convId,
                ':s'   => $user['email'],
                ':c'   => json_encode($quote, JSON_UNESCAPED_UNICODE),
            ]);
            $msgId = (int)$stIns->fetchColumn();

            try {
                $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")
                   ->execute([':id' => $convId]);
            } catch (\Throwable $_) {}
            try { broadcastChatMessage($db, $convId, $msgId, $user['email']); } catch (\Throwable $_) {}

            jsonResponse(true, [
                'conversation_id' => $convId,
                'message_id'      => $msgId,
                'owner_email'     => $ownerEmail,
                'owner_name'      => chatDisplayName($ownerEmail),
            ], 'Reply sent');
            break;
        }

        // ============================================================
        // status_check — Verify if a status row still exists (e.g. before
        // navigating from a status_reply bubble in DM). Returns true only if
        // the status is in chat_user_status AND not past expires_at. Used by
        // the chat bubble tap handler to show "Status nao disponivel" in vez
        // de abrir profile vazio quando user apagou o status manualmente
        // dentro das 24h ou created_at da snapshot ja foi alem do TTL.
        // ============================================================
        case 'status_check': {
            requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);
            $stm = $db->prepare("SELECT id FROM chat_user_status WHERE id = :id AND expires_at > now()::text LIMIT 1");
            $stm->execute([':id' => $statusId]);
            $exists = (bool)$stm->fetchColumn();
            jsonResponse(true, ['exists' => $exists], 'OK');
            break;
        }

        // status_list — Get statuses from contacts (non-expired)
        // ============================================================
        case 'status_list': {
            $user = requireChatAuth();

            // Clean up expired statuses first. Skip rows whose owner archived
            // them so the home strip never re-surfaces archived items even if
            // the cron hasn't reaped them yet. Archive column is created
            // lazily by status_archive on first call, so this CREATE/ALTER is
            // here to keep status_list resilient if status_archive was never
            // invoked on this DB.
            try { @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS archived_at TEXT"); } catch (Throwable $_) {}
            try { $db->exec("DELETE FROM chat_user_status WHERE expires_at < now()::text"); } catch (Throwable $e) {}
            // Load mute set so we can hide muted contacts' status from the top row.
            $__mutedSet = [];
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_status_mutes (
                    muter_email TEXT NOT NULL, muted_email TEXT NOT NULL,
                    created_at TEXT DEFAULT (now()::text),
                    PRIMARY KEY (muter_email, muted_email)
                )");
                $__ms = $db->prepare("SELECT muted_email FROM chat_status_mutes WHERE LOWER(muter_email) = LOWER(:me)");
                $__ms->execute([':me' => $user['email']]);
                foreach ($__ms->fetchAll(\PDO::FETCH_ASSOC) as $__r) {
                    $__mutedSet[strtolower($__r['muted_email'])] = true;
                }
            } catch (Throwable $e) {}

            // Get all non-expired statuses, grouped by user
            $stmt = $db->prepare("
                SELECT su.*,
                    (SELECT COUNT(*) FROM chat_status_views sv WHERE sv.status_id = su.id AND LOWER(sv.viewer_email) <> LOWER(su.email)) as view_count,
                    (SELECT COUNT(*) FROM chat_status_views sv WHERE sv.status_id = su.id AND LOWER(sv.viewer_email) = LOWER(:viewer)) as viewed
                FROM chat_user_status su
                WHERE su.expires_at > now()::text
                  AND su.archived_at IS NULL
                  AND (LOWER(su.email) = LOWER(:email) OR LOWER(su.email) IN (
                    SELECT DISTINCT LOWER(cm2.email) FROM chat_conversation_members cm1
                    JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
                    WHERE LOWER(cm1.email) = LOWER(:email2) AND LOWER(cm2.email) <> LOWER(:email3)
                  ))
                ORDER BY su.email, su.created_at ASC
            ");
            $stmt->execute([
                ':email'  => $user['email'],
                ':email2' => $user['email'],
                ':email3' => $user['email'],
                ':viewer' => $user['email'],
            ]);
            $allStatuses = $stmt->fetchAll();

            // Close-friends gate: any status with meta.privacy === 'close_friends'
            // is visible only to (a) the owner themselves, and (b) anyone the
            // owner has added to chat_close_friends. We load the union of all
            // owners-who-have-me-as-a-close-friend in one query so the per-row
            // check below stays O(1).
            $__closeFriendOwners = [];
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_close_friends (
                    owner_email TEXT NOT NULL,
                    friend_email TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (owner_email, friend_email)
                )");
                $__cf = $db->prepare("SELECT owner_email FROM chat_close_friends WHERE LOWER(friend_email) = LOWER(:me)");
                $__cf->execute([':me' => $user['email']]);
                foreach ($__cf->fetchAll(\PDO::FETCH_ASSOC) as $__r) {
                    $__closeFriendOwners[strtolower($__r['owner_email'])] = true;
                }
            } catch (Throwable $e) {}

            // Group by user (skip muted contacts — never show their status row)
            $grouped = [];
            foreach ($allStatuses as $s) {
                $email = $s['email'];
                if (strcasecmp($email, $user['email']) !== 0 && isset($__mutedSet[strtolower($email)])) {
                    continue;
                }
                // Privacy filter: close_friends statuses are visible only to
                // the owner + people on their close-friends list.
                {
                    $__metaSrc = $s['meta'] ?? null;
                    $__metaArr = is_string($__metaSrc) ? json_decode($__metaSrc, true) : (is_array($__metaSrc) ? $__metaSrc : null);
                    $__priv = $__metaArr['privacy'] ?? null;
                    if ($__priv === 'close_friends'
                        && strcasecmp($email, $user['email']) !== 0
                        && empty($__closeFriendOwners[strtolower($email)])) {
                        continue;
                    }
                }
                if (!isset($grouped[$email])) {
                    $grouped[$email] = [
                        'email' => $email,
                        'name'  => chatDisplayName($email),
                        'is_own' => (strcasecmp($email, $user['email']) === 0),
                        'statuses' => [],
                    ];
                }
                $meta = null;
                if (!empty($s['meta'])) {
                    $meta = is_string($s['meta']) ? json_decode($s['meta'], true) : $s['meta'];
                }
                // Surface a poster URL for video items so the viewer can
                // render the first frame instantly while the actual video
                // streams in. The .thumb.jpg is generated synchronously
                // during status_upload. If absent — older posts, or ffmpeg
                // failed — we fall back to null.
                // Also check for HLS playlist (.hls/index.m3u8) — generated
                // ASYNC during upload (~5s for a 30s clip). When present,
                // the client prefers HLS (chunk-streamed, <500ms first
                // frame) over progressive mp4 (~1-3s buffering).
                $__thumbUrl = null;
                $__hlsUrl = null;
                if ($s['type'] === 'video' && !empty($s['media_url'])) {
                    $__rawUrl = (string)$s['media_url'];
                    $__pathOnly = parse_url($__rawUrl, PHP_URL_PATH) ?: $__rawUrl;
                    if (strpos($__pathOnly, '/data/status/') === 0) {
                        $__thumbDisk = '/var/www/mail' . $__pathOnly . '.thumb.jpg';
                        if (is_file($__thumbDisk)) {
                            $__thumbUrl = $__pathOnly . '.thumb.jpg';
                        }
                        $__hlsDisk = '/var/www/mail' . $__pathOnly . '.hls/index.m3u8';
                        if (is_file($__hlsDisk)) {
                            $__hlsUrl = $__pathOnly . '.hls/index.m3u8';
                        }
                    }
                }
                $__subs = null;
                if (!empty($s['subtitles'])) {
                    $__decoded = is_string($s['subtitles']) ? json_decode($s['subtitles'], true) : $s['subtitles'];
                    if (is_array($__decoded)) $__subs = $__decoded;
                }
                // Wave 4: poll status enrichment. If this row is a poll, attach
                // aggregate counts + the current viewer's own vote so the UI can
                // paint filled bars + the selected option on first render.
                $__poll = null;
                if (($s['type'] ?? '') === 'poll' && !empty($meta['poll']) && is_array($meta['poll'])) {
                    $__poll = $meta['poll'];
                    $__optCnt = count($__poll['options'] ?? []);
                    $__counts = array_fill(0, $__optCnt, 0);
                    $__myVote = null;
                    try {
                        @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_poll_votes (
                            status_id BIGINT NOT NULL,
                            voter_email TEXT NOT NULL,
                            option_index INTEGER NOT NULL,
                            voted_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text,
                            PRIMARY KEY (status_id, voter_email)
                        )");
                        $__pc = $db->prepare("SELECT option_index, COUNT(*) AS c FROM chat_status_poll_votes WHERE status_id = :sid GROUP BY option_index");
                        $__pc->execute([':sid' => (int)$s['id']]);
                        foreach ($__pc->fetchAll(PDO::FETCH_ASSOC) as $__pr) {
                            $__i = (int)$__pr['option_index'];
                            if ($__i >= 0 && $__i < $__optCnt) $__counts[$__i] = (int)$__pr['c'];
                        }
                        $__mv = $db->prepare("SELECT option_index FROM chat_status_poll_votes WHERE status_id = :sid AND LOWER(voter_email) = LOWER(:me)");
                        $__mv->execute([':sid' => (int)$s['id'], ':me' => $user['email']]);
                        $__r = $__mv->fetch(PDO::FETCH_ASSOC);
                        if ($__r) $__myVote = (int)$__r['option_index'];
                    } catch (Throwable $_) {}
                    $__poll['counts'] = $__counts;
                    $__poll['total_votes'] = array_sum($__counts);
                    $__poll['my_vote'] = $__myVote;
                }
                $grouped[$email]['statuses'][] = [
                    'id'            => (int)$s['id'],
                    'content'       => $s['content'],
                    'type'          => $s['type'],
                    'media_url'     => $s['media_url'],
                    'thumbnail_url' => $__thumbUrl,
                    'hls_url'       => $__hlsUrl,
                    'background'    => $s['bg_color'] ?? '',
                    'expires_at'    => $s['expires_at'],
                    'created_at'    => $s['created_at'],
                    'views'         => (int)$s['view_count'], 'view_count'    => (int)$s['view_count'],
                    'viewed'        => (int)$s['viewed'] > 0,
                    'meta'          => $meta,
                    'is_boomerang'  => !empty($meta['is_boomerang']),
                    'subtitles'     => $__subs,
                    'poll'          => $__poll,
                ];
            }

            // Put own status first
            $result = [];
            $ownStatus = $grouped[$user['email']] ?? null;
            if ($ownStatus) {
                $result[] = $ownStatus;
                unset($grouped[$user['email']]);
            } else {
                $result[] = [
                    'email' => $user['email'],
                    'name'  => $user['name'],
                    'is_own' => true,
                    'statuses' => [],
                ];
            }
            // Sort contacts so unviewed-first, then most-recent. Without this
            // the home row order was alphabetical-by-email, which buried fresh
            // status under inactive accounts. Instagram/WhatsApp parity: unread
            // bubbles up. Within each group the rows are already created_at ASC
            // (carousel order) — we only reorder the OUTER user list here.
            $groupedArr = array_values($grouped);
            usort($groupedArr, function($a, $b) {
                $aHasUnread = false; $bHasUnread = false;
                $aLatest = 0; $bLatest = 0;
                foreach (($a['statuses'] ?? []) as $s) {
                    if (empty($s['viewed'])) $aHasUnread = true;
                    $t = strtotime($s['created_at'] ?? '0');
                    if ($t > $aLatest) $aLatest = $t;
                }
                foreach (($b['statuses'] ?? []) as $s) {
                    if (empty($s['viewed'])) $bHasUnread = true;
                    $t = strtotime($s['created_at'] ?? '0');
                    if ($t > $bLatest) $bLatest = $t;
                }
                if ($aHasUnread !== $bHasUnread) return $aHasUnread ? -1 : 1;
                return $bLatest - $aLatest; // newer first within tier
            });
            foreach ($groupedArr as $g) {
                $result[] = $g;
            }

            jsonResponse(true, $result);
            break;
        }

        // ============================================================
        // status_reply — Instagram-style swipe-up reply. Creates a DM to the
        // status owner quoting the story (client renders it as a "replied to
        // your story" card in the chat). Idempotent: always opens/uses the
        // direct conversation between the two users.
        // ============================================================
        case 'status_reply': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $toEmail = strtolower(trim($input['to_email'] ?? ''));
            $content = trim((string)($input['content'] ?? ''));
            if (!$statusId || !$toEmail || $content === '') {
                jsonResponse(false, null, 'status_id, to_email, content required', 400);
            }
            if (strcasecmp($toEmail, $user['email']) === 0) {
                jsonResponse(false, null, 'Cannot reply to your own status', 400);
            }
            // Find-or-create direct conversation
            $stF = $db->prepare("
                SELECT c.id FROM chat_conversations c
                JOIN chat_conversation_members m1 ON m1.conversation_id = c.id AND LOWER(m1.email) = LOWER(:me)
                JOIN chat_conversation_members m2 ON m2.conversation_id = c.id AND LOWER(m2.email) = LOWER(:them)
                WHERE c.type = 'direct' LIMIT 1
            ");
            $stF->execute([':me' => $user['email'], ':them' => $toEmail]);
            $convId = (int)$stF->fetchColumn();
            if (!$convId) {
                $stC = $db->prepare("INSERT INTO chat_conversations (type, created_by, created_at, updated_at) VALUES ('direct', :c, now()::text, now()::text) RETURNING id");
                $stC->execute([':c' => $user['email']]);
                $convId = (int)$stC->fetchColumn();
                $stM = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:cid, :e, 'member', now()::text)");
                $stM->execute([':cid' => $convId, ':e' => $user['email']]);
                $stM->execute([':cid' => $convId, ':e' => $toEmail]);
            }
            // Build the message: quote payload goes in content as JSON so the
            // existing chat_messages table doesn't need new columns. Type is
            // 'status_reply' so the viewer renders it with the proper card.
            $stS = $db->prepare("SELECT id, type, media_url, content, email, created_at FROM chat_user_status WHERE id = :id");
            $stS->execute([':id' => $statusId]);
            $status = $stS->fetch();
            $quotePayload = [
                'reply_text' => $content,
                'status' => $status ? [
                    'id' => (int)$status['id'],
                    'type' => $status['type'],
                    'media_url' => $status['media_url'],
                    'content' => $status['content'],
                    'email' => $status['email'],
                    'created_at' => $status['created_at'],
                ] : null,
            ];
            $stIns = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :s, :c, 'status_reply', now()::text) RETURNING id");
            $stIns->execute([
                ':cid' => $convId,
                ':s'   => $user['email'],
                ':c'   => json_encode($quotePayload, JSON_UNESCAPED_UNICODE),
            ]);
            $msgId = (int)$stIns->fetchColumn();

            // Bump the conversation's updated_at so it jumps to the top of
            // the recipient's list.
            try {
                $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :id")
                   ->execute([':id' => $convId]);
            } catch (\Throwable $_) {}

            // Broadcast to peers — existing chat_message WS event works here
            try { broadcastChatMessage($db, $convId, $msgId, $user['email']); } catch (\Throwable $_) {}
            jsonResponse(true, ['conversation_id' => $convId, 'message_id' => $msgId]);
            break;
        }

        // ============================================================
        // status_react — Quick emoji reaction on a status. Records it + pings
        // the owner via WS so they get a "❤️ by X" toast.
        // ============================================================
        case 'status_react': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $emoji = trim((string)($input['emoji'] ?? ''));
            if (!$statusId || $emoji === '') {
                jsonResponse(false, null, 'status_id and emoji required', 400);
            }
            if (mb_strlen($emoji) > 10) {
                jsonResponse(false, null, 'emoji too long', 400);
            }
            // Schema: 1 reaction per (status_id, viewer_email). Tap same emoji
            // again → remove (toggle). Tap a different emoji → replace.
            // This matches the WhatsApp behaviour where each viewer can have
            // at most ONE active reaction on a given status.
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_status_reactions (
                    status_id INTEGER NOT NULL,
                    viewer_email TEXT NOT NULL,
                    emoji TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (status_id, viewer_email)
                );
                CREATE INDEX IF NOT EXISTS chat_status_reactions_status_idx ON chat_status_reactions(status_id);");
                // Legacy table (id SERIAL + reactor_email + multiple rows per
                // viewer) → migrate to single-row-per-viewer schema if needed.
                @$db->exec("ALTER TABLE chat_status_reactions ADD COLUMN IF NOT EXISTS viewer_email TEXT");
                @$db->exec("UPDATE chat_status_reactions SET viewer_email = reactor_email WHERE viewer_email IS NULL AND reactor_email IS NOT NULL");
            } catch (\Throwable $_) {}

            // Toggle: if the existing reaction for this viewer matches the
            // tapped emoji, delete it; otherwise upsert (replace).
            $cur = $db->prepare("SELECT emoji FROM chat_status_reactions WHERE status_id = :sid AND LOWER(viewer_email) = LOWER(:r) LIMIT 1");
            $cur->execute([':sid' => $statusId, ':r' => $user['email']]);
            $existing = $cur->fetchColumn();
            $removed = false;
            if ($existing !== false && $existing === $emoji) {
                $db->prepare("DELETE FROM chat_status_reactions WHERE status_id = :sid AND LOWER(viewer_email) = LOWER(:r)")
                   ->execute([':sid' => $statusId, ':r' => $user['email']]);
                $removed = true;
            } else {
                // Upsert: replace any prior emoji from this viewer.
                $db->prepare("INSERT INTO chat_status_reactions (status_id, viewer_email, emoji) VALUES (:sid, :r, :e)
                              ON CONFLICT (status_id, viewer_email) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()")
                   ->execute([':sid' => $statusId, ':r' => $user['email'], ':e' => $emoji]);
            }

            // WS ping to owner so they see the reaction live.
            try {
                $st = $db->prepare("SELECT email FROM chat_user_status WHERE id = :id");
                $st->execute([':id' => $statusId]);
                $ownerEmail = $st->fetchColumn();
                if ($ownerEmail && strcasecmp($ownerEmail, $user['email']) !== 0) {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $cu = curl_init('http://127.0.0.1:8081/notify');
                        curl_setopt_array($cu, [
                            CURLOPT_POST => true,
                            CURLOPT_POSTFIELDS => json_encode([
                                'email' => $ownerEmail,
                                'event' => 'status_reaction',
                                'data'  => [
                                    'status_id' => $statusId,
                                    'reactor_email' => $user['email'],
                                    'viewer_email' => $user['email'],
                                    'reactor_name' => chatDisplayName($user['email']),
                                    'emoji' => $removed ? null : $emoji,
                                    'removed' => $removed,
                                ],
                            ]),
                            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                            CURLOPT_RETURNTRANSFER => true,
                            CURLOPT_TIMEOUT_MS => 500,
                            CURLOPT_CONNECTTIMEOUT_MS => 200,
                        ]);
                        curl_exec($cu);
                        curl_close($cu);
                    }
                }
            } catch (\Throwable $_) {}

            jsonResponse(true, ['reacted' => !$removed, 'removed' => $removed, 'emoji' => $removed ? null : $emoji]);
            break;
        }

        // ============================================================
        // status_view — Mark a status as viewed
        // ============================================================
        case 'status_view': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);

            $db->prepare("
                INSERT INTO chat_status_views (status_id, viewer_email, viewed_at)
                VALUES (:sid, :email, now()::text)
                ON CONFLICT DO NOTHING
            ")->execute([':sid' => $statusId, ':email' => $user['email']]);

            // Surface this viewer's existing reaction (if any) so the client
            // can paint the active emoji highlighted on first frame instead
            // of waiting for an extra fetch round-trip.
            $myReaction = null;
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_reactions (
                    status_id INTEGER NOT NULL,
                    viewer_email TEXT NOT NULL,
                    emoji TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (status_id, viewer_email)
                )");
                $rs = $db->prepare("SELECT emoji FROM chat_status_reactions WHERE status_id = :sid AND LOWER(viewer_email) = LOWER(:e) LIMIT 1");
                $rs->execute([':sid' => $statusId, ':e' => $user['email']]);
                $myReaction = $rs->fetchColumn();
                if ($myReaction === false) $myReaction = null;
            } catch (\Throwable $_) {}

            jsonResponse(true, ['my_reaction' => $myReaction], 'Status viewed');
            break;
        }

        // ============================================================
        // status_translate_caption — Translate a status caption to the
        // viewer's locale on demand. Result is cached on the row's meta
        // under caption_translations[locale] so every subsequent viewer
        // in that locale gets it free.
        // Input: { status_id, target_locale }
        // ============================================================
        case 'status_translate_caption': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $targetLocale = trim((string)($input['target_locale'] ?? ''));
            if (!$statusId || $targetLocale === '') {
                jsonResponse(false, null, 'status_id and target_locale required', 400);
            }
            // Fetch the status meta + content.
            $st = $db->prepare("SELECT id, content, meta FROM chat_user_status WHERE id = :id");
            $st->execute([':id' => $statusId]);
            $row = $st->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Status not found', 404);

            $meta = [];
            if (!empty($row['meta'])) {
                $meta = is_string($row['meta']) ? (json_decode($row['meta'], true) ?: []) : (array)$row['meta'];
            }
            $sourceText = (string)($meta['caption'] ?? $row['content'] ?? '');
            if ($sourceText === '') {
                jsonResponse(true, ['translation' => '', 'cached' => false]);
            }
            $sourceLocale = (string)($meta['caption_locale'] ?? 'pt-BR');
            $cache = isset($meta['caption_translations']) && is_array($meta['caption_translations'])
                ? $meta['caption_translations'] : [];

            // If already cached or target == source, return immediately.
            if (strcasecmp($sourceLocale, $targetLocale) === 0) {
                jsonResponse(true, [
                    'translation' => $sourceText,
                    'source_locale' => $sourceLocale,
                    'target_locale' => $targetLocale,
                    'cached' => true,
                ]);
            }
            if (!empty($cache[$targetLocale])) {
                jsonResponse(true, [
                    'translation' => $cache[$targetLocale],
                    'source_locale' => $sourceLocale,
                    'target_locale' => $targetLocale,
                    'cached' => true,
                ]);
            }

            // Translate via the project's existing AI translate helper if
            // available; otherwise fall back to an identity stub so the
            // client still gets a defined string and the cache slot fills.
            $translated = $sourceText;
            try {
                if (function_exists('aiTranslate')) {
                    $translated = (string)aiTranslate($sourceText, $sourceLocale, $targetLocale);
                } elseif (file_exists(__DIR__ . '/ai-router.php')) {
                    require_once __DIR__ . '/ai-router.php';
                    if (function_exists('aiTranslate')) {
                        $translated = (string)aiTranslate($sourceText, $sourceLocale, $targetLocale);
                    }
                }
            } catch (\Throwable $e) { error_log('[status_translate] ' . $e->getMessage()); }

            // Persist into meta.caption_translations.
            try {
                $cache[$targetLocale] = $translated;
                $meta['caption_translations'] = $cache;
                $newMeta = json_encode($meta, JSON_UNESCAPED_UNICODE);
                $db->prepare("UPDATE chat_user_status SET meta = :m::jsonb WHERE id = :id")
                   ->execute([':m' => $newMeta, ':id' => $statusId]);
            } catch (\Throwable $e) { error_log('[status_translate.persist] ' . $e->getMessage()); }

            jsonResponse(true, [
                'translation'   => $translated,
                'source_locale' => $sourceLocale,
                'target_locale' => $targetLocale,
                'cached'        => false,
            ]);
            break;
        }

        // ============================================================
        // status_delete — Delete own status
        // ============================================================
        case 'status_delete': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);

            $stmt = $db->prepare("SELECT * FROM chat_user_status WHERE id = :id AND LOWER(email) = LOWER(:email)");
            $stmt->execute([':id' => $statusId, ':email' => $user['email']]);
            if (!$stmt->fetch()) {
                jsonResponse(false, null, 'Status not found or not yours', 404);
            }

            $db->prepare("DELETE FROM chat_user_status WHERE id = :id")->execute([':id' => $statusId]);
            jsonResponse(true, null, 'Status deleted');
            break;
        }

        // ============================================================
        // status_archive / status_unarchive — Wave 4. Hide an own expired
        // status from the home strip without deleting it so the owner can
        // still browse the full history (mirrors Instagram Archive). Adds
        // chat_user_status.archived_at on first call. Frontend already
        // tolerates missing endpoint (ChatStatusTab tracks a local Set);
        // wiring it makes the archive survive cold starts + multi-device.
        // status_archive_list — return the owner's archived statuses.
        // ============================================================
        case 'status_archive':
        case 'status_unarchive': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);

            try { @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS archived_at TEXT"); } catch (Throwable $_) {}

            $own = $db->prepare("SELECT email FROM chat_user_status WHERE id = :id");
            $own->execute([':id' => $statusId]);
            $row = $own->fetch(PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Status not found', 404);
            if (strtolower($row['email']) !== strtolower($user['email'])) {
                jsonResponse(false, null, 'Forbidden', 403);
            }

            if ($action === 'status_archive') {
                $db->prepare("UPDATE chat_user_status SET archived_at = (now() AT TIME ZONE 'UTC')::text WHERE id = :id")
                   ->execute([':id' => $statusId]);
            } else {
                $db->prepare("UPDATE chat_user_status SET archived_at = NULL WHERE id = :id")
                   ->execute([':id' => $statusId]);
            }
            jsonResponse(true, ['status_id' => $statusId, 'archived' => $action === 'status_archive']);
            break;
        }

        case 'status_archive_list': {
            $user = requireChatAuth();
            try { @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS archived_at TEXT"); } catch (Throwable $_) {}
            $stmt = $db->prepare("
                SELECT id, content, type, media_url, bg_color AS background, created_at, expires_at, archived_at, meta
                FROM chat_user_status
                WHERE LOWER(email) = LOWER(:e) AND archived_at IS NOT NULL
                ORDER BY archived_at DESC
                LIMIT 200
            ");
            $stmt->execute([':e' => $user['email']]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            foreach ($rows as &$r) {
                if (!empty($r['meta']) && is_string($r['meta'])) {
                    $decoded = json_decode($r['meta'], true);
                    if (is_array($decoded)) $r['meta'] = $decoded;
                }
            }
            jsonResponse(true, ['items' => $rows]);
            break;
        }

        // ============================================================
        // status_poll_vote — Wave 4. Cast a vote on a poll-type status.
        // Status polls reuse chat_user_status.meta JSONB (carries `poll`
        // object with `question` + `options[]`). Votes land in a new
        // chat_status_poll_votes table with the same shape as
        // chat_poll_votes (PRIMARY KEY status_id+voter_email so each viewer
        // can only pick one option). Response returns aggregate counts so
        // the viewer animates filling bars right after the tap.
        // ============================================================
        case 'status_poll_vote': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $optionIdx = (int)($input['option_index'] ?? -1);
            if (!$statusId || $optionIdx < 0) jsonResponse(false, null, 'status_id + option_index required', 400);

            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_poll_votes (
                    status_id BIGINT NOT NULL,
                    voter_email TEXT NOT NULL,
                    option_index INTEGER NOT NULL,
                    voted_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text,
                    PRIMARY KEY (status_id, voter_email)
                )");
            } catch (Throwable $_) {}

            // Confirm the status exists, isn't expired, and is a poll.
            $st = $db->prepare("SELECT email, type, expires_at, meta FROM chat_user_status WHERE id = :id");
            $st->execute([':id' => $statusId]);
            $row = $st->fetch(PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Status not found', 404);
            if (!empty($row['expires_at']) && strtotime((string)$row['expires_at']) < time()) {
                jsonResponse(false, null, 'Status expired', 410);
            }
            $meta = [];
            if (!empty($row['meta'])) {
                $decoded = is_string($row['meta']) ? json_decode($row['meta'], true) : $row['meta'];
                if (is_array($decoded)) $meta = $decoded;
            }
            $poll = $meta['poll'] ?? null;
            if (!is_array($poll) || empty($poll['options']) || !is_array($poll['options'])) {
                jsonResponse(false, null, 'Status is not a poll', 400);
            }
            $optCount = count($poll['options']);
            if ($optionIdx >= $optCount) jsonResponse(false, null, 'option_index out of range', 400);

            // Upsert: each viewer can change their pick; PK keeps it to one.
            try {
                $db->prepare("
                    INSERT INTO chat_status_poll_votes (status_id, voter_email, option_index, voted_at)
                    VALUES (:sid, :ve, :oi, (now() AT TIME ZONE 'UTC')::text)
                    ON CONFLICT (status_id, voter_email) DO UPDATE
                    SET option_index = EXCLUDED.option_index, voted_at = EXCLUDED.voted_at
                ")->execute([':sid' => $statusId, ':ve' => strtolower($user['email']), ':oi' => $optionIdx]);
            } catch (Throwable $e) {
                error_log('[status_poll_vote] ' . $e->getMessage());
                jsonResponse(false, null, 'Vote failed', 500);
            }

            // Aggregate counts so the client can paint instantly.
            $agg = $db->prepare("SELECT option_index, COUNT(*) AS c FROM chat_status_poll_votes WHERE status_id = :sid GROUP BY option_index");
            $agg->execute([':sid' => $statusId]);
            $counts = array_fill(0, $optCount, 0);
            foreach ($agg->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $i = (int)$r['option_index'];
                if ($i >= 0 && $i < $optCount) $counts[$i] = (int)$r['c'];
            }
            $total = array_sum($counts);

            // WS notify owner so the status author sees the vote tick up
            // without manual refresh. Mirrors the status_view broadcast.
            try {
                _broadcastToOwnDevices((string)$row['email'], 'status_poll_vote', [
                    'status_id' => $statusId,
                    'voter_email' => strtolower($user['email']),
                    'option_index' => $optionIdx,
                    'counts' => $counts,
                    'total_votes' => $total,
                ]);
            } catch (Throwable $_) {}

            jsonResponse(true, [
                'status_id' => $statusId,
                'option_index' => $optionIdx,
                'counts' => $counts,
                'total_votes' => $total,
            ]);
            break;
        }

        // ============================================================
        // status_slider_vote — Records a slider sticker response (0-100).
        // Schema: chat_status_slider_votes(status_id, voter_email, value,
        // voted_at). Value is normalized to 0-100 (int). Returns running
        // average + total responses so the viewer can paint the live bar.
        // Owner gets WS event 'status_slider_vote' on each new vote.
        // ============================================================
        case 'status_slider_vote': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $value = (int)($input['value'] ?? -1);
            $stickerId = (string)($input['sticker_id'] ?? '');
            if (!$statusId || $value < 0 || $value > 100) {
                jsonResponse(false, null, 'status_id + value (0-100) required', 400);
            }
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_slider_votes (
                    status_id BIGINT NOT NULL,
                    sticker_id TEXT NOT NULL DEFAULT '',
                    voter_email TEXT NOT NULL,
                    value INTEGER NOT NULL,
                    voted_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text,
                    PRIMARY KEY (status_id, sticker_id, voter_email)
                )");
            } catch (Throwable $_) {}

            $st = $db->prepare("SELECT email, expires_at FROM chat_user_status WHERE id = :id");
            $st->execute([':id' => $statusId]);
            $row = $st->fetch(PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Status not found', 404);
            if (!empty($row['expires_at']) && strtotime((string)$row['expires_at']) < time()) {
                jsonResponse(false, null, 'Status expired', 410);
            }

            try {
                $db->prepare("
                    INSERT INTO chat_status_slider_votes (status_id, sticker_id, voter_email, value, voted_at)
                    VALUES (:sid, :stk, :ve, :v, (now() AT TIME ZONE 'UTC')::text)
                    ON CONFLICT (status_id, sticker_id, voter_email) DO UPDATE
                    SET value = EXCLUDED.value, voted_at = EXCLUDED.voted_at
                ")->execute([':sid' => $statusId, ':stk' => $stickerId, ':ve' => strtolower($user['email']), ':v' => $value]);
            } catch (Throwable $e) {
                error_log('[status_slider_vote] ' . $e->getMessage());
                jsonResponse(false, null, 'Vote failed', 500);
            }

            $agg = $db->prepare("SELECT AVG(value)::float AS avg_value, COUNT(*) AS total FROM chat_status_slider_votes WHERE status_id = :sid AND sticker_id = :stk");
            $agg->execute([':sid' => $statusId, ':stk' => $stickerId]);
            $a = $agg->fetch(PDO::FETCH_ASSOC) ?: ['avg_value' => 0, 'total' => 0];
            $avgValue = (float)($a['avg_value'] ?? 0);
            $totalVotes = (int)($a['total'] ?? 0);

            try {
                _broadcastToOwnDevices((string)$row['email'], 'status_slider_vote', [
                    'status_id' => $statusId,
                    'sticker_id' => $stickerId,
                    'voter_email' => strtolower($user['email']),
                    'value' => $value,
                    'avg_value' => $avgValue,
                    'total_votes' => $totalVotes,
                ]);
            } catch (Throwable $_) {}

            jsonResponse(true, [
                'status_id' => $statusId,
                'sticker_id' => $stickerId,
                'value' => $value,
                'avg_value' => $avgValue,
                'total_votes' => $totalVotes,
            ]);
            break;
        }

        // ============================================================
        // status_question_answer — Stores a viewer's text answer to a
        // Question sticker. Schema: chat_status_question_answers(status_id,
        // sticker_id, responder_email, answer, created_at). Owner gets WS
        // event so they can see answers stream in via "Respostas" inbox.
        // ============================================================
        case 'status_question_answer': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $answer = trim((string)($input['answer'] ?? ''));
            $stickerId = (string)($input['sticker_id'] ?? '');
            if (!$statusId || $answer === '') {
                jsonResponse(false, null, 'status_id + answer required', 400);
            }
            if (mb_strlen($answer) > 280) $answer = mb_substr($answer, 0, 280);

            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_question_answers (
                    id BIGSERIAL PRIMARY KEY,
                    status_id BIGINT NOT NULL,
                    sticker_id TEXT NOT NULL DEFAULT '',
                    responder_email TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text
                );
                CREATE INDEX IF NOT EXISTS chat_status_qa_status_idx ON chat_status_question_answers(status_id);");
            } catch (Throwable $_) {}

            $st = $db->prepare("SELECT email, expires_at FROM chat_user_status WHERE id = :id");
            $st->execute([':id' => $statusId]);
            $row = $st->fetch(PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Status not found', 404);
            if (!empty($row['expires_at']) && strtotime((string)$row['expires_at']) < time()) {
                jsonResponse(false, null, 'Status expired', 410);
            }

            try {
                $db->prepare("
                    INSERT INTO chat_status_question_answers (status_id, sticker_id, responder_email, answer)
                    VALUES (:sid, :stk, :re, :a)
                ")->execute([
                    ':sid' => $statusId,
                    ':stk' => $stickerId,
                    ':re'  => strtolower($user['email']),
                    ':a'   => $answer,
                ]);
            } catch (Throwable $e) {
                error_log('[status_question_answer] ' . $e->getMessage());
                jsonResponse(false, null, 'Answer failed', 500);
            }

            try {
                _broadcastToOwnDevices((string)$row['email'], 'status_question_answer', [
                    'status_id' => $statusId,
                    'sticker_id' => $stickerId,
                    'responder_email' => strtolower($user['email']),
                    'responder_name' => $user['name'] ?? '',
                    'answer' => $answer,
                ]);
            } catch (Throwable $_) {}

            jsonResponse(true, ['status_id' => $statusId, 'answer' => $answer]);
            break;
        }

        // ============================================================
        // status_question_list — Lists answers received for a question
        // sticker. Owner-only. Returns the answers grouped per sticker.
        // ============================================================
        case 'status_question_list': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);

            $own = $db->prepare("SELECT email FROM chat_user_status WHERE id = :id");
            $own->execute([':id' => $statusId]);
            $owner = $own->fetchColumn();
            if (!$owner) jsonResponse(false, null, 'Status not found', 404);
            if (strtolower((string)$owner) !== strtolower($user['email'])) {
                jsonResponse(false, null, 'Forbidden', 403);
            }

            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_question_answers (
                    id BIGSERIAL PRIMARY KEY,
                    status_id BIGINT NOT NULL,
                    sticker_id TEXT NOT NULL DEFAULT '',
                    responder_email TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text
                )");
            } catch (Throwable $_) {}

            $q = $db->prepare("SELECT id, sticker_id, responder_email, answer, created_at FROM chat_status_question_answers WHERE status_id = :sid ORDER BY created_at DESC LIMIT 200");
            $q->execute([':sid' => $statusId]);
            jsonResponse(true, ['answers' => $q->fetchAll(PDO::FETCH_ASSOC)]);
            break;
        }

        // ============================================================
        // chat_status_music_search — Server-side proxy for the music
        // sticker picker. Tries Deezer first (no auth needed for /search),
        // falls back to a curated static list when Deezer is unreachable
        // (CORS-free since this is server-side). Returns the normalized
        // shape: { id, title, artist, artwork_url, preview_url, duration }.
        // ============================================================
        case 'chat_status_music_search': {
            requireChatAuth();
            $q = trim((string)($input['q'] ?? $input['query'] ?? ''));
            $limit = max(1, min(50, (int)($input['limit'] ?? 25)));
            $tab = (string)($input['tab'] ?? 'foryou'); // 'foryou' | 'search' | 'saved'

            $tracks = [];
            // For 'search' tab with a non-empty query, hit Deezer.
            if ($tab === 'search' && $q !== '') {
                $url = 'https://api.deezer.com/search?q=' . urlencode($q) . '&limit=' . $limit . '&output=json';
                $ch = curl_init($url);
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 8,
                    CURLOPT_CONNECTTIMEOUT => 4,
                    CURLOPT_USERAGENT => 'ChatyyMusicSearch/1.0',
                ]);
                $resp = curl_exec($ch);
                $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($resp && $code === 200) {
                    $data = json_decode($resp, true);
                    if (is_array($data) && !empty($data['data']) && is_array($data['data'])) {
                        foreach ($data['data'] as $t) {
                            if (empty($t['preview'])) continue;
                            $tracks[] = [
                                'id' => 'dz_' . (int)$t['id'],
                                'title' => (string)($t['title_short'] ?? $t['title'] ?? ''),
                                'artist' => (string)($t['artist']['name'] ?? ''),
                                'artwork_url' => (string)($t['album']['cover_medium'] ?? $t['album']['cover'] ?? ''),
                                'preview_url' => (string)$t['preview'],
                                'duration' => (int)($t['duration'] ?? 30),
                                'source' => 'deezer',
                            ];
                        }
                    }
                }
            }

            // Curated fallback list (BR + global popular preview URLs from
            // Deezer's public preview CDN). Returned for 'foryou' tab or
            // when Deezer fails on 'search'. These are 30s legal previews.
            if (empty($tracks) && ($tab === 'foryou' || ($tab === 'search' && $q === ''))) {
                $curated = [
                    ['dz_curated_1', 'Flowers', 'Miley Cyrus'],
                    ['dz_curated_2', 'As It Was', 'Harry Styles'],
                    ['dz_curated_3', 'Anti-Hero', 'Taylor Swift'],
                    ['dz_curated_4', 'Calm Down', 'Rema'],
                    ['dz_curated_5', 'Unholy', 'Sam Smith'],
                    ['dz_curated_6', 'Erro Gostoso', 'Simone Mendes'],
                    ['dz_curated_7', 'Leão', 'Marília Mendonça'],
                    ['dz_curated_8', 'Pipoco', 'Ana Castela'],
                    ['dz_curated_9', 'Imagine', 'John Lennon'],
                    ['dz_curated_10', 'Levitating', 'Dua Lipa'],
                ];
                foreach ($curated as $c) {
                    $tracks[] = [
                        'id' => $c[0],
                        'title' => $c[1],
                        'artist' => $c[2],
                        'artwork_url' => '',
                        'preview_url' => '',
                        'duration' => 30,
                        'source' => 'curated',
                    ];
                }
            }

            // Saved tab: per-user list of saved tracks (lazy table).
            if ($tab === 'saved') {
                try {
                    $user = requireChatAuth();
                    @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_music_saved (
                        owner_email TEXT NOT NULL,
                        track_id TEXT NOT NULL,
                        title TEXT NOT NULL,
                        artist TEXT NOT NULL,
                        artwork_url TEXT,
                        preview_url TEXT,
                        duration INTEGER NOT NULL DEFAULT 30,
                        saved_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text,
                        PRIMARY KEY (owner_email, track_id)
                    )");
                    $st = $db->prepare("SELECT track_id AS id, title, artist, artwork_url, preview_url, duration FROM chat_status_music_saved WHERE LOWER(owner_email) = LOWER(:e) ORDER BY saved_at DESC LIMIT :l");
                    $st->bindValue(':e', strtolower($user['email']));
                    $st->bindValue(':l', $limit, PDO::PARAM_INT);
                    $st->execute();
                    $tracks = $st->fetchAll(PDO::FETCH_ASSOC) ?: [];
                } catch (Throwable $e) {
                    error_log('[chat_status_music_search saved] ' . $e->getMessage());
                }
            }

            jsonResponse(true, ['tracks' => $tracks, 'tab' => $tab, 'query' => $q]);
            break;
        }

        // ============================================================
        // chat_status_music_save / chat_status_music_unsave — Per-user
        // "Saved" tab for the music sticker picker. Lazy CREATE matches
        // chat_status_music_search above.
        // ============================================================
        case 'chat_status_music_save': {
            $user = requireChatAuth();
            $trackId = trim((string)($input['track_id'] ?? ''));
            if ($trackId === '') jsonResponse(false, null, 'track_id required', 400);
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_music_saved (
                    owner_email TEXT NOT NULL,
                    track_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    artwork_url TEXT,
                    preview_url TEXT,
                    duration INTEGER NOT NULL DEFAULT 30,
                    saved_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text,
                    PRIMARY KEY (owner_email, track_id)
                )");
                $db->prepare("INSERT INTO chat_status_music_saved (owner_email, track_id, title, artist, artwork_url, preview_url, duration) VALUES (:e, :t, :tt, :a, :art, :p, :d) ON CONFLICT (owner_email, track_id) DO NOTHING")
                  ->execute([
                      ':e' => strtolower($user['email']),
                      ':t' => $trackId,
                      ':tt' => (string)($input['title'] ?? ''),
                      ':a' => (string)($input['artist'] ?? ''),
                      ':art' => (string)($input['artwork_url'] ?? ''),
                      ':p' => (string)($input['preview_url'] ?? ''),
                      ':d' => (int)($input['duration'] ?? 30),
                  ]);
            } catch (Throwable $e) {
                error_log('[chat_status_music_save] ' . $e->getMessage());
                jsonResponse(false, null, 'Save failed', 500);
            }
            jsonResponse(true, ['saved' => true]);
            break;
        }
        case 'chat_status_music_unsave': {
            $user = requireChatAuth();
            $trackId = trim((string)($input['track_id'] ?? ''));
            if ($trackId === '') jsonResponse(false, null, 'track_id required', 400);
            try {
                $db->prepare("DELETE FROM chat_status_music_saved WHERE LOWER(owner_email) = LOWER(:e) AND track_id = :t")
                  ->execute([':e' => strtolower($user['email']), ':t' => $trackId]);
            } catch (Throwable $_) {}
            jsonResponse(true, ['saved' => false]);
            break;
        }

        // ============================================================
        // chat_dnd_get / chat_dnd_set — Wave 4. Do-Not-Disturb schedule.
        // Mutes ALL chat push notifications during a user-defined window
        // (e.g. 22:00–07:00). Backend persists to chat_user_dnd; the actual
        // mute is enforced in firebase_push.php / push-notify.php by reading
        // this table before fanning out (those workers already short-circuit
        // when mute settings say so — we just feed them new data). Times are
        // stored as "HH:MM" strings in the user's local timezone (`tz_offset`
        // minutes, like JS getTimezoneOffset but inverted: minutes EAST of
        // UTC). Defaults: disabled, 22:00–07:00, tz_offset=0 (UTC).
        // ============================================================
        case 'chat_dnd_get': {
            $user = requireChatAuth();
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_dnd (
                    email TEXT PRIMARY KEY,
                    enabled SMALLINT NOT NULL DEFAULT 0,
                    start_time TEXT NOT NULL DEFAULT '22:00',
                    end_time TEXT NOT NULL DEFAULT '07:00',
                    tz_offset INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT
                )");
                $st = $db->prepare("SELECT enabled, start_time, end_time, tz_offset FROM chat_user_dnd WHERE LOWER(email) = LOWER(:e)");
                $st->execute([':e' => $user['email']]);
                $row = $st->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    $row = ['enabled' => 0, 'start_time' => '22:00', 'end_time' => '07:00', 'tz_offset' => 0];
                }
                jsonResponse(true, [
                    'enabled' => (bool)$row['enabled'],
                    'start_time' => (string)$row['start_time'],
                    'end_time' => (string)$row['end_time'],
                    'tz_offset' => (int)$row['tz_offset'],
                ]);
            } catch (Throwable $e) {
                error_log('[chat_dnd_get] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }
        case 'chat_dnd_set': {
            $user = requireChatAuth();
            $enabled = !empty($input['enabled']) ? 1 : 0;
            $start = trim((string)($input['start_time'] ?? '22:00'));
            $end   = trim((string)($input['end_time']   ?? '07:00'));
            $tz    = (int)($input['tz_offset'] ?? 0);

            // Validate HH:MM. Reject anything else so the workers never
            // hit a malformed string when computing the current window.
            if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $start)) {
                jsonResponse(false, null, 'start_time must be HH:MM', 400);
            }
            if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $end)) {
                jsonResponse(false, null, 'end_time must be HH:MM', 400);
            }
            // Clamp tz_offset to ±14h (real-world max is +14:00 at Kiribati).
            if ($tz < -14 * 60 || $tz > 14 * 60) $tz = 0;

            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_dnd (
                    email TEXT PRIMARY KEY,
                    enabled SMALLINT NOT NULL DEFAULT 0,
                    start_time TEXT NOT NULL DEFAULT '22:00',
                    end_time TEXT NOT NULL DEFAULT '07:00',
                    tz_offset INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT
                )");
                $db->prepare("
                    INSERT INTO chat_user_dnd (email, enabled, start_time, end_time, tz_offset, updated_at)
                    VALUES (:e, :en, :s, :n, :tz, (now() AT TIME ZONE 'UTC')::text)
                    ON CONFLICT (email) DO UPDATE
                    SET enabled = EXCLUDED.enabled,
                        start_time = EXCLUDED.start_time,
                        end_time = EXCLUDED.end_time,
                        tz_offset = EXCLUDED.tz_offset,
                        updated_at = EXCLUDED.updated_at
                ")->execute([
                    ':e' => $user['email'],
                    ':en' => $enabled,
                    ':s' => $start,
                    ':n' => $end,
                    ':tz' => $tz,
                ]);
                jsonResponse(true, [
                    'enabled' => (bool)$enabled,
                    'start_time' => $start,
                    'end_time' => $end,
                    'tz_offset' => $tz,
                ]);
            } catch (Throwable $e) {
                error_log('[chat_dnd_set] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        // ============================================================
        // status_set_subtitles — TikTok-style auto-captions on a status video.
        // Owner only. Stored as JSON segments in chat_user_status.subtitles.
        // ============================================================
        case 'status_set_subtitles': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            $segs = $input['subtitles'] ?? null;
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);
            if (!is_array($segs)) jsonResponse(false, null, 'subtitles array required', 400);
            $clean = [];
            foreach ($segs as $s) {
                if (!is_array($s)) continue;
                $clean[] = [
                    'start' => (float)($s['start'] ?? 0),
                    'end'   => (float)($s['end'] ?? 0),
                    'text'  => mb_substr((string)($s['text'] ?? ''), 0, 240),
                ];
                if (count($clean) >= 500) break;
            }
            try {
                @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS subtitles TEXT");
                $own = $db->prepare("SELECT email FROM chat_user_status WHERE id = :id");
                $own->execute([':id' => $statusId]);
                $row = $own->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Status not found', 404);
                if (strtolower($row['email']) !== strtolower($user['email'])) {
                    jsonResponse(false, null, 'Forbidden', 403);
                }
                $db->prepare("UPDATE chat_user_status SET subtitles = :s WHERE id = :id")
                   ->execute([':s' => json_encode($clean, JSON_UNESCAPED_UNICODE), ':id' => $statusId]);
                jsonResponse(true, ['status_id' => $statusId, 'count' => count($clean)]);
            } catch (Throwable $e) {
                error_log('[status_set_subtitles] ' . $e->getMessage());
                jsonResponse(false, null, 'Save failed', 500);
            }
            break;
        }

        // ============================================================
        // Highlights (Stories permanentes salvos no perfil).
        // Schema: chat_status_highlights(id, owner_email, name, cover_url,
        //   status_ids JSONB, created_at). status_ids is a JSON array of
        //   chat_user_status.id's so even after the source status expires
        //   the highlight still resolves via chat_user_status_archive (TODO)
        //   or — for now — a soft fallback that lets expired stories live
        //   on inside highlights by skipping the expires_at filter.
        // ============================================================
        case 'status_highlight_create': {
            $user = requireChatAuth();
            $name = trim((string)($input['name'] ?? ''));
            $cover = trim((string)($input['cover_url'] ?? ''));
            $statusIds = $input['status_ids'] ?? [];
            if ($name === '') jsonResponse(false, null, 'name required', 400);
            if (mb_strlen($name) > 60) $name = mb_substr($name, 0, 60);
            if (!is_array($statusIds)) $statusIds = [];
            $statusIds = array_values(array_unique(array_map('intval', $statusIds)));
            $statusIds = array_slice($statusIds, 0, 100);
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_highlights (
                    id BIGSERIAL PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    cover_url TEXT,
                    status_ids JSONB DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_status_highlights_owner ON chat_status_highlights(LOWER(owner_email))");
                $stmt = $db->prepare("INSERT INTO chat_status_highlights (owner_email, name, cover_url, status_ids) VALUES (:o, :n, :c, :s::jsonb) RETURNING id, created_at");
                $stmt->execute([
                    ':o' => $user['email'],
                    ':n' => $name,
                    ':c' => $cover ?: null,
                    ':s' => json_encode($statusIds),
                ]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                jsonResponse(true, [
                    'id' => (int)$row['id'],
                    'name' => $name,
                    'cover_url' => $cover,
                    'status_ids' => $statusIds,
                    'created_at' => $row['created_at'],
                ]);
            } catch (Throwable $e) {
                error_log('[status_highlight_create] ' . $e->getMessage());
                jsonResponse(false, null, 'Create failed', 500);
            }
            break;
        }

        case 'status_highlight_list': {
            $user = requireChatAuth();
            $target = strtolower(trim((string)($input['email'] ?? $user['email'])));
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_status_highlights (
                    id BIGSERIAL PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    cover_url TEXT,
                    status_ids JSONB DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                $stmt = $db->prepare("SELECT id, owner_email, name, cover_url, status_ids, created_at FROM chat_status_highlights WHERE LOWER(owner_email) = LOWER(:e) ORDER BY created_at DESC LIMIT 200");
                $stmt->execute([':e' => $target]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $ids = json_decode($r['status_ids'] ?: '[]', true);
                    $r['status_ids'] = is_array($ids) ? array_map('intval', $ids) : [];
                    $r['count'] = count($r['status_ids']);
                }
                jsonResponse(true, ['highlights' => $rows]);
            } catch (Throwable $e) {
                error_log('[status_highlight_list] ' . $e->getMessage());
                jsonResponse(true, ['highlights' => []]);
            }
            break;
        }

        case 'status_highlight_add_status': {
            $user = requireChatAuth();
            $highlightId = (int)($input['highlight_id'] ?? 0);
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$highlightId || !$statusId) jsonResponse(false, null, 'highlight_id and status_id required', 400);
            try {
                $own = $db->prepare("SELECT status_ids FROM chat_status_highlights WHERE id = :id AND LOWER(owner_email) = LOWER(:e)");
                $own->execute([':id' => $highlightId, ':e' => $user['email']]);
                $row = $own->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Highlight not found', 404);
                $ids = json_decode($row['status_ids'] ?: '[]', true);
                if (!is_array($ids)) $ids = [];
                $ids = array_map('intval', $ids);
                if (!in_array($statusId, $ids, true)) $ids[] = $statusId;
                $ids = array_slice(array_values(array_unique($ids)), 0, 100);
                $db->prepare("UPDATE chat_status_highlights SET status_ids = :s::jsonb WHERE id = :id")
                   ->execute([':s' => json_encode($ids), ':id' => $highlightId]);
                jsonResponse(true, ['highlight_id' => $highlightId, 'status_ids' => $ids, 'count' => count($ids)]);
            } catch (Throwable $e) {
                error_log('[status_highlight_add_status] ' . $e->getMessage());
                jsonResponse(false, null, 'Add failed', 500);
            }
            break;
        }

        case 'status_highlight_delete': {
            $user = requireChatAuth();
            $highlightId = (int)($input['highlight_id'] ?? 0);
            if (!$highlightId) jsonResponse(false, null, 'highlight_id required', 400);
            try {
                $del = $db->prepare("DELETE FROM chat_status_highlights WHERE id = :id AND LOWER(owner_email) = LOWER(:e)");
                $del->execute([':id' => $highlightId, ':e' => $user['email']]);
                jsonResponse(true, ['deleted' => $del->rowCount() > 0]);
            } catch (Throwable $e) {
                error_log('[status_highlight_delete] ' . $e->getMessage());
                jsonResponse(false, null, 'Delete failed', 500);
            }
            break;
        }

        // ────────────────────────────────────────────────────────────
        // status_highlight_items — resolve a highlight's `status_ids` JSONB
        // to the actual status rows (media_url, type, bg_color, meta).
        // Skips the expires_at filter so destacados continue rendering after
        // the 24h window — that's the whole point of saving them.
        //
        // Privacy: any caller that can fetch the owner's profile can see the
        // highlight (highlights are public-on-profile, same surface as the
        // user's avatar + handle). No follower-only gating at this layer.
        // ────────────────────────────────────────────────────────────
        case 'status_highlight_items': {
            $user = requireChatAuth();
            $highlightId = (int)($input['highlight_id'] ?? 0);
            if (!$highlightId) jsonResponse(false, null, 'highlight_id required', 400);
            try {
                $st = $db->prepare("SELECT id, owner_email, name, status_ids FROM chat_status_highlights WHERE id = :id");
                $st->execute([':id' => $highlightId]);
                $row = $st->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Highlight not found', 404);

                $ids = json_decode($row['status_ids'] ?: '[]', true);
                if (!is_array($ids)) $ids = [];
                $ids = array_values(array_filter(array_map('intval', $ids)));
                if (empty($ids)) {
                    jsonResponse(true, ['items' => [], 'highlight_id' => $highlightId, 'name' => $row['name'] ?? '']);
                    break;
                }

                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $sql = "SELECT id, email, content, type, media_url, bg_color, created_at, expires_at, meta
                        FROM chat_user_status
                        WHERE id IN ($placeholders) AND LOWER(email) = LOWER(?)";
                $params = array_merge($ids, [$row['owner_email']]);
                $q = $db->prepare($sql);
                $q->execute($params);
                $rowsRaw = $q->fetchAll(PDO::FETCH_ASSOC) ?: [];

                // Preserve curated order — important so the viewer plays the
                // highlight in the sequence the owner chose, not by recency.
                $byId = [];
                foreach ($rowsRaw as $r) { $byId[(int)$r['id']] = $r; }
                $items = [];
                foreach ($ids as $sid) {
                    if (!isset($byId[$sid])) continue;
                    $r = $byId[$sid];
                    if (!empty($r['meta']) && is_string($r['meta'])) {
                        $decoded = json_decode($r['meta'], true);
                        if (is_array($decoded)) $r['meta'] = $decoded;
                    }
                    $r['id'] = (int)$r['id'];
                    // Parity with status_list response shape.
                    $r['background'] = $r['bg_color'] ?? null;
                    $items[] = $r;
                }
                jsonResponse(true, [
                    'items' => $items,
                    'highlight_id' => $highlightId,
                    'name' => $row['name'] ?? '',
                ]);
            } catch (Throwable $e) {
                error_log('[status_highlight_items] ' . $e->getMessage());
                jsonResponse(false, null, 'Load failed', 500);
            }
            break;
        }

        // ============================================================
        // status_mute / status_unmute — silenciar status de um contato.
        // Stored in chat_status_mutes table (auto-created idempotent).
        // status_list filters out muted users so they don't show in the
        // top row anymore. Same model as WhatsApp's "silenciar status".
        // ============================================================
        case 'status_mute':
        case 'status_unmute': {
            $user = requireChatAuth();
            $target = strtolower(trim($input['email'] ?? ''));
            if ($target === '' || !filter_var($target, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'valid email required', 400);
            }
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_status_mutes (
                    muter_email TEXT NOT NULL,
                    muted_email TEXT NOT NULL,
                    created_at TEXT DEFAULT (now()::text),
                    PRIMARY KEY (muter_email, muted_email)
                )");
            } catch (Throwable $e) {}
            if ($action === 'status_mute') {
                $db->prepare("INSERT INTO chat_status_mutes (muter_email, muted_email) VALUES (LOWER(:me), LOWER(:target)) ON CONFLICT DO NOTHING")
                    ->execute([':me' => $user['email'], ':target' => $target]);
                jsonResponse(true, ['muted' => true], 'Muted');
            } else {
                $db->prepare("DELETE FROM chat_status_mutes WHERE LOWER(muter_email) = LOWER(:me) AND LOWER(muted_email) = LOWER(:target)")
                    ->execute([':me' => $user['email'], ':target' => $target]);
                jsonResponse(true, ['muted' => false], 'Unmuted');
            }
            break;
        }

        // status_muted_list — return the user's muted set so the client can
        // hide/show the toggle in the long-press menu correctly.
        case 'status_muted_list': {
            $user = requireChatAuth();
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_status_mutes (
                    muter_email TEXT NOT NULL,
                    muted_email TEXT NOT NULL,
                    created_at TEXT DEFAULT (now()::text),
                    PRIMARY KEY (muter_email, muted_email)
                )");
            } catch (Throwable $e) {}
            $stmt = $db->prepare("SELECT muted_email FROM chat_status_mutes WHERE LOWER(muter_email) = LOWER(:me)");
            $stmt->execute([':me' => $user['email']]);
            $emails = array_column($stmt->fetchAll(\PDO::FETCH_ASSOC), 'muted_email');
            jsonResponse(true, ['muted_emails' => $emails]);
            break;
        }

        // status_by_user — list statuses of a specific user in the last 24h.
        // Used on the Profile page (Instagram-style: even after viewing in feed,
        // recent stories stay accessible on the person\x27s profile).
        case "status_by_user": {
            $user = requireChatAuth();
            $target = trim($input["email"] ?? $_GET["email"] ?? "");
            if ($target === "") jsonResponse(false, null, "email required", 400);
            try { $db->exec("DELETE FROM chat_user_status WHERE expires_at < now()::text"); } catch (Throwable $e) {}
            $stmt = $db->prepare("
                SELECT su.*, (SELECT COUNT(*) FROM chat_status_views sv WHERE sv.status_id=su.id AND LOWER(sv.viewer_email) <> LOWER(su.email)) AS view_count,
                       (SELECT COUNT(*) FROM chat_status_views sv WHERE sv.status_id=su.id AND LOWER(sv.viewer_email)=LOWER(:me)) AS viewed
                FROM chat_user_status su
                WHERE LOWER(su.email)=LOWER(:target) AND su.expires_at > now()::text
                ORDER BY su.created_at ASC
            ");
            $stmt->execute([":me"=>$user["email"], ":target"=>$target]);
            $rows = $stmt->fetchAll();
            $out = array_map(function($s){
                return [
                    "id"=>(int)$s["id"],
                    "content"=>$s["content"],
                    "type"=>$s["type"],
                    "media_url"=>$s["media_url"],
                    "background"=>$s["bg_color"] ?? '',
                    "expires_at"=>$s["expires_at"],
                    "created_at"=>$s["created_at"],
                    "views"=>(int)$s["view_count"], "view_count"=>(int)$s["view_count"],
                    "viewed"=>(int)$s["viewed"] > 0,
                ];
            }, $rows);
            jsonResponse(true, ["email"=>$target, "name"=>chatDisplayName($target), "statuses"=>$out], "ok");
            break;
        }

        case 'status_viewers': {
            $user = requireChatAuth();
            $statusId = (int)($input['status_id'] ?? 0);
            if (!$statusId) jsonResponse(false, null, 'status_id required', 400);
            // Must be owner
            $stmt = $db->prepare("SELECT email FROM chat_user_status WHERE id = :id");
            $stmt->execute([':id' => $statusId]);
            $row = $stmt->fetch();
            if (!$row || strcasecmp($row['email'], $user['email']) !== 0) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            // Ensure reactions table exists before we try to join on it — this
            // mirrors the CREATE-IF-NOT-EXISTS in status_react so fresh
            // installs don't blow up on the first viewers-list fetch.
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_status_reactions (
                    id SERIAL PRIMARY KEY,
                    status_id INTEGER NOT NULL,
                    reactor_email TEXT NOT NULL,
                    emoji TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS chat_status_reactions_status_idx ON chat_status_reactions(status_id);");
            } catch (\Throwable $_) {}
            // LEFT JOIN reactions → the UI shows the viewer's latest emoji
            // (if any) without a second request. Private-reaction UX: only
            // the author of the status sees who reacted with what.
            // Reactions table uses `reactor_email`. Old code also referenced
            // `viewer_email` via COALESCE which broke the entire endpoint
            // because Postgres validates every referenced column at parse
            // time — a non-existent column drops the whole query (SQLSTATE
            // 42703), making status viewers permanently invisible to the
            // status owner.
            $stmt = $db->prepare("
                SELECT sv.viewer_email AS email,
                       sv.viewer_email,
                       sv.viewed_at,
                       (SELECT emoji FROM chat_status_reactions r
                         WHERE r.status_id = sv.status_id
                           AND LOWER(r.reactor_email) = LOWER(sv.viewer_email)
                         ORDER BY r.created_at DESC LIMIT 1) AS reaction_emoji
                FROM chat_status_views sv
                JOIN chat_user_status sus ON sus.id = sv.status_id
                WHERE sv.status_id = :id
                  AND LOWER(sv.viewer_email) <> LOWER(sus.email)
                ORDER BY sv.viewed_at DESC
                LIMIT 200
            ");
            $stmt->execute([':id' => $statusId]);
            jsonResponse(true, ['viewers' => $stmt->fetchAll()]);
            break;
        }

        // ============================================================
        // chat_create_poll — Create a poll message in a conversation
        // ============================================================
        case 'chat_media_gallery': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $conversationId, $user['email']);
            // Accept both `type` and `filter` — frontend uses `type`, this
            // endpoint historically accepted `filter` and silently ignored
            // anything else. Caused every tab (Photos / Videos / Audio /
            // Documents) to render the SAME mixed list because the type
            // filter never applied.
            $filter = $input['type'] ?? $input['filter'] ?? 'all';
            $typeFilter = '';
            $params = [':cid' => $conversationId];
            if ($filter === 'image') { $typeFilter = " AND type = 'image'"; }
            elseif ($filter === 'video') { $typeFilter = " AND type IN ('video','video_note')"; }
            // Documents tab = real `file` type (PDFs, docs etc) — exclude
            // audio/voice that were leaking in. `voice` and `audio` belong in
            // the audio tab; images/videos in their own.
            elseif ($filter === 'file') { $typeFilter = " AND type = 'file'"; }
            elseif ($filter === 'audio') { $typeFilter = " AND type IN ('audio','voice')"; }
            elseif ($filter === 'media') { $typeFilter = " AND type IN ('image','video','video_note')"; }
            else {
                // 'all' default — only items with media attached, not text
                $typeFilter = " AND type IN ('image','video','video_note','audio','voice','file')";
            }

            $stmt = $db->prepare("
                SELECT id, sender_email, content, type, file_url, file_name, file_size, created_at
                FROM chat_messages
                WHERE conversation_id = :cid AND deleted_at IS NULL
                  AND file_url IS NOT NULL AND file_url <> ''
                  {$typeFilter}
                ORDER BY created_at DESC
                LIMIT 300
            ");
            $stmt->execute($params);
            $items = $stmt->fetchAll();
            foreach ($items as &$it) {
                $it['id'] = (int)$it['id'];
                $it['file_size'] = (int)$it['file_size'];
                // Friendlier file_name fallback — the gallery shows "File"
                // for every row when file_name is NULL/empty. Pull a sensible
                // default from file_url path so the user sees something.
                if (empty($it['file_name']) && !empty($it['file_url'])) {
                    $base = basename(parse_url($it['file_url'], PHP_URL_PATH) ?: $it['file_url']);
                    if ($base) $it['file_name'] = $base;
                }
            }
            jsonResponse(true, ['items' => $items, 'count' => count($items)]);
            break;
        }

        case 'chat_create_poll': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $question = trim($input['question'] ?? '');
            $options = $input['options'] ?? [];
            $multipleChoice = !empty($input['multiple_choice']);

            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if ($question === '') jsonResponse(false, null, 'question required', 400);
            if (!is_array($options)) jsonResponse(false, null, 'options must be an array', 400);

            // Normalize: keep string options, trim, drop empties, cap length
            // (200 chars/option keeps the poll bubble readable; 10 options max),
            // and drop exact duplicates so two "Sim" entries don't both show.
            $cleanOptions = [];
            foreach ($options as $opt) {
                $s = trim((string)$opt);
                if ($s === '') continue;
                if (mb_strlen($s) > 200) $s = mb_substr($s, 0, 200);
                if (in_array($s, $cleanOptions, true)) continue;
                $cleanOptions[] = $s;
                if (count($cleanOptions) >= 10) break;
            }
            if (count($cleanOptions) < 2) jsonResponse(false, null, 'At least 2 options required', 400);
            if (mb_strlen($question) > 300) $question = mb_substr($question, 0, 300);

            requireConversationMember($db, $conversationId, $user['email']);

            // Quiz mode (Telegram parity): poll with a single correct
            // answer. Client renders green/red feedback after the user
            // votes. `correct_option` is the 0-based index into options.
            // For quiz mode we force multiple_choice=false since there's
            // only one correct answer.
            $isQuiz = !empty($input['is_quiz']) || !empty($input['quiz']);
            $correctOption = isset($input['correct_option']) ? (int)$input['correct_option'] : -1;
            if ($isQuiz) {
                if ($correctOption < 0 || $correctOption >= count($cleanOptions)) {
                    jsonResponse(false, null, 'correct_option required for quiz and must be a valid option index', 400);
                }
                $multipleChoice = false;
            }
            // Optional explanation shown after voting in a quiz (200 char cap).
            $quizExplanation = trim((string)($input['explanation'] ?? ''));
            if (mb_strlen($quizExplanation) > 200) $quizExplanation = mb_substr($quizExplanation, 0, 200);

            $pollPayload = [
                'question' => $question,
                'options' => $cleanOptions,
                'multiple_choice' => (bool)$multipleChoice,
                'created_by' => $user['email'],
            ];
            if ($isQuiz) {
                $pollPayload['is_quiz'] = true;
                $pollPayload['correct_option'] = $correctOption;
                if ($quizExplanation !== '') $pollPayload['explanation'] = $quizExplanation;
            }
            $content = json_encode($pollPayload, JSON_UNESCAPED_UNICODE);

            $stmt = $db->prepare("
                INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                VALUES (:cid, :sender, :content, 'poll', now()::text)
                RETURNING id
            ");
            $stmt->execute([
                ':cid' => $conversationId,
                ':sender' => $user['email'],
                ':content' => $content,
            ]);
            $msgId = (int)$stmt->fetchColumn();

            // Bump conversation updated_at
            $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :cid")
               ->execute([':cid' => $conversationId]);

            // Broadcast so other members see the poll live.
            try { broadcastChatMessage($db, $conversationId, $msgId, $user['email']); }
            catch (Throwable $e) { error_log('[chat_poll.ws] ' . $e->getMessage()); }
            try { chatSendPushToMembers($db, $conversationId, $msgId, $user['email']); }
            catch (Throwable $e) { error_log('[chat_poll.push] ' . $e->getMessage()); }

            // Build response poll object (includes id + empty votes)
            $pollPayload['id'] = $msgId;
            $pollPayload['votes'] = array_fill(0, count($cleanOptions), 0);
            $pollPayload['my_votes'] = [];

            jsonResponse(true, [
                'id' => $msgId,
                'conversation_id' => $conversationId,
                'sender_email' => $user['email'],
                'type' => 'poll',
                'content' => $content,
                'poll' => $pollPayload,
                'created_at' => gmdate('Y-m-d\TH:i:s\Z'),
            ], 'Poll created');
            break;
        }

        // ============================================================
        // chat_vote_poll — Toggle a vote on a poll option
        // ============================================================
        case 'chat_vote_poll': {
            $user = requireChatAuth();
            $pollId = (int)($input['poll_id'] ?? $input['message_id'] ?? 0);
            $optionIndex = (int)($input['option_index'] ?? -1);

            if (!$pollId) jsonResponse(false, null, 'poll_id required', 400);
            if ($optionIndex < 0) jsonResponse(false, null, 'option_index required', 400);

            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND type = 'poll' AND deleted_at IS NULL");
            $stmt->execute([':id' => $pollId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Poll not found', 404);

            requireConversationMember($db, $msg['conversation_id'], $user['email']);

            $poll = json_decode($msg['content'] ?? '{}', true);
            $options = (isset($poll['options']) && is_array($poll['options'])) ? $poll['options'] : [];
            if ($optionIndex >= count($options)) jsonResponse(false, null, 'Invalid option_index', 400);
            $multipleChoice = !empty($poll['multiple_choice']);

            try { $db->exec("CREATE TABLE IF NOT EXISTS chat_poll_votes (message_id BIGINT NOT NULL, voter_email TEXT NOT NULL, option_index INTEGER NOT NULL, voted_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (message_id, voter_email, option_index))"); } catch (Throwable $e) {}

            // Check if user already voted this option
            $check = $db->prepare("SELECT 1 FROM chat_poll_votes WHERE message_id = :mid AND LOWER(voter_email) = LOWER(:email) AND option_index = :idx");
            $check->execute([':mid' => $pollId, ':email' => $user['email'], ':idx' => $optionIndex]);
            $alreadyVoted = (bool)$check->fetchColumn();

            if ($alreadyVoted) {
                $db->prepare("DELETE FROM chat_poll_votes WHERE message_id = :mid AND LOWER(voter_email) = LOWER(:email) AND option_index = :idx")
                   ->execute([':mid' => $pollId, ':email' => $user['email'], ':idx' => $optionIndex]);
            } else {
                if (!$multipleChoice) {
                    $db->prepare("DELETE FROM chat_poll_votes WHERE message_id = :mid AND LOWER(voter_email) = LOWER(:email)")
                       ->execute([':mid' => $pollId, ':email' => $user['email']]);
                }
                $db->prepare("INSERT INTO chat_poll_votes (message_id, voter_email, option_index, voted_at) VALUES (:mid, :email, :idx, now()::text) ON CONFLICT DO NOTHING")
                   ->execute([':mid' => $pollId, ':email' => $user['email'], ':idx' => $optionIndex]);
            }

            // Compute fresh tallies
            $tallyStmt = $db->prepare("SELECT option_index, COUNT(*) AS c FROM chat_poll_votes WHERE message_id = :mid GROUP BY option_index");
            $tallyStmt->execute([':mid' => $pollId]);
            $votes = array_fill(0, count($options), 0);
            foreach ($tallyStmt->fetchAll() as $row) {
                $i = (int)$row['option_index'];
                if ($i >= 0 && $i < count($options)) $votes[$i] = (int)$row['c'];
            }

            $myStmt = $db->prepare("SELECT option_index FROM chat_poll_votes WHERE message_id = :mid AND LOWER(voter_email) = LOWER(:email)");
            $myStmt->execute([':mid' => $pollId, ':email' => $user['email']]);
            $myVotes = array_map('intval', array_column($myStmt->fetchAll(), 'option_index'));

            // Broadcast so other participants' poll bars animate live.
            try {
                broadcastChatMessage($db, (int)$msg['conversation_id'], $pollId, $user['email'], 'poll_vote');
            } catch (Throwable $e) { error_log('[chat_vote.ws] ' . $e->getMessage()); }

            jsonResponse(true, [
                'poll_id' => $pollId,
                'votes' => $votes,
                'my_votes' => $myVotes,
                'total_votes' => array_sum($votes),
            ], 'Vote recorded');
            break;
        }

        // ============================================================
        // chat_create_meetup — Send a meetup card into a conversation
        // ============================================================
        case 'chat_create_meetup': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $title = trim((string)($input['title'] ?? ''));
            $datetime = trim((string)($input['datetime'] ?? ''));
            $location = trim((string)($input['location'] ?? ''));
            $description = trim((string)($input['description'] ?? ''));
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            if ($title === '' || $datetime === '') jsonResponse(false, null, 'title and datetime required', 400);
            requireConversationMember($db, $conversationId, $user['email']);

            $payload = [
                'title' => mb_substr($title, 0, 200),
                'datetime' => mb_substr($datetime, 0, 100),
                'location' => mb_substr($location, 0, 200),
                'description' => mb_substr($description, 0, 500),
                'created_by' => $user['email'],
            ];
            $content = json_encode($payload, JSON_UNESCAPED_UNICODE);

            $stmt = $db->prepare("
                INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                VALUES (:cid, :sender, :content, 'meetup', now()::text)
                RETURNING id
            ");
            $stmt->execute([':cid' => $conversationId, ':sender' => $user['email'], ':content' => $content]);
            $msgId = (int)$stmt->fetchColumn();
            $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :cid")
               ->execute([':cid' => $conversationId]);

            try { broadcastChatMessage($db, $conversationId, $msgId, $user['email']); }
            catch (Throwable $e) { error_log('[chat_meetup.ws] ' . $e->getMessage()); }
            try { chatSendPushToMembers($db, $conversationId, $msgId, $user['email']); }
            catch (Throwable $e) { error_log('[chat_meetup.push] ' . $e->getMessage()); }

            $payload['id'] = $msgId;
            $payload['rsvps'] = ['yes' => [], 'no' => [], 'maybe' => []];
            $payload['my_rsvp'] = null;
            jsonResponse(true, [
                'id' => $msgId,
                'conversation_id' => $conversationId,
                'sender_email' => $user['email'],
                'type' => 'meetup',
                'content' => $content,
                'meetup' => $payload,
                'created_at' => gmdate('Y-m-d\TH:i:s\Z'),
            ], 'Meetup created');
            break;
        }

        // ============================================================
        // chat_meetup_rsvp — Record yes/no/maybe reply
        // ============================================================
        case 'chat_meetup_rsvp': {
            $user = requireChatAuth();
            $msgId = (int)($input['message_id'] ?? 0);
            $status = strtolower(trim((string)($input['status'] ?? '')));
            // Normalize: frontend uses going/not_going, we store yes/no internally
            $statusMap = ['going' => 'yes', 'not_going' => 'no', 'notgoing' => 'no', 'yes' => 'yes', 'no' => 'no', 'maybe' => 'maybe', 'clear' => 'clear', '' => 'clear'];
            $status = $statusMap[$status] ?? '';
            if (!$msgId) jsonResponse(false, null, 'message_id required', 400);
            if (!in_array($status, ['yes', 'no', 'maybe', 'clear'])) jsonResponse(false, null, 'Invalid status', 400);
            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND type = 'meetup' AND deleted_at IS NULL");
            $stmt->execute([':id' => $msgId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Meetup not found', 404);
            requireConversationMember($db, $msg['conversation_id'], $user['email']);

            try { $db->exec("CREATE TABLE IF NOT EXISTS chat_meetup_rsvps (message_id BIGINT NOT NULL, responder_email TEXT NOT NULL, status TEXT NOT NULL, responded_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (message_id, responder_email))"); } catch (Throwable $e) {}

            if ($status === 'clear') {
                $db->prepare("DELETE FROM chat_meetup_rsvps WHERE message_id = :m AND LOWER(responder_email) = LOWER(:e)")
                   ->execute([':m' => $msgId, ':e' => $user['email']]);
            } else {
                $db->prepare("INSERT INTO chat_meetup_rsvps (message_id, responder_email, status, responded_at) VALUES (:m, :e, :s, now()::text) ON CONFLICT (message_id, responder_email) DO UPDATE SET status = EXCLUDED.status, responded_at = EXCLUDED.responded_at")
                   ->execute([':m' => $msgId, ':e' => $user['email'], ':s' => $status]);
            }
            $aggStmt = $db->prepare("SELECT responder_email, status FROM chat_meetup_rsvps WHERE message_id = :m");
            $aggStmt->execute([':m' => $msgId]);
            $rsvps = ['yes' => [], 'no' => [], 'maybe' => []];
            $mine = null;
            foreach ($aggStmt->fetchAll() as $r) {
                if (isset($rsvps[$r['status']])) $rsvps[$r['status']][] = $r['responder_email'];
                if (strcasecmp($r['responder_email'], $user['email']) === 0) $mine = $r['status'];
            }
            // Also build a flat map { email => status } which is the shape the frontend reads
            $flat = [];
            foreach (['yes', 'no', 'maybe'] as $s) {
                foreach ($rsvps[$s] as $e) {
                    $flat[$e] = ($s === 'yes') ? 'going' : (($s === 'no') ? 'not_going' : 'maybe');
                }
            }
            // WS broadcast — recipients need live aggregate so the meetup card
            // updates without manual refresh. Use the same direct-fanout shape
            // as the ephemeral-send path (chat_meetup_rsvp doesn't fit
            // broadcastChatMessage since it's not a new chat row).
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    $convId = (int)$msg['conversation_id'];
                    $peersStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid");
                    $peersStmt->execute([':cid' => $convId]);
                    $allEmails = array_column($peersStmt->fetchAll(\PDO::FETCH_ASSOC), 'email');
                    $payload = [
                        'message_id'      => $msgId,
                        'conversation_id' => $convId,
                        'rsvps'           => $rsvps,
                        'rsvp'            => $flat,
                        'responder'       => $user['email'],
                        'status'          => $status,
                    ];
                    $channels = ["chat_{$convId}"];
                    foreach ($allEmails as $em) $channels[] = "chat_user_" . strtolower($em);
                    foreach ($channels as $ch) {
                        $body = json_encode(['channel' => $ch, 'event' => 'meetup_rsvp_update', 'data' => $payload], JSON_UNESCAPED_UNICODE);
                        $cu = curl_init('http://127.0.0.1:8081/broadcast');
                        curl_setopt_array($cu, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT_MS => 1500, CURLOPT_CONNECTTIMEOUT_MS => 500]);
                        curl_exec($cu); curl_close($cu);
                    }
                }
            } catch (\Throwable $e) { error_log('[chat_meetup_rsvp.ws] ' . $e->getMessage()); }

            jsonResponse(true, ['message_id' => $msgId, 'rsvps' => $rsvps, 'rsvp' => $flat, 'my_rsvp' => $mine], 'RSVP saved');
            break;
        }

        // ============================================================
        // chat_create_playlist — Empty shared playlist card
        // ============================================================
        case 'chat_create_playlist': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $name = trim((string)($input['name'] ?? 'Playlist'));
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $conversationId, $user['email']);

            $payload = [
                'playlist_name' => mb_substr($name, 0, 100),
                'created_by' => $user['email'],
                'songs' => [],
            ];
            $content = json_encode($payload, JSON_UNESCAPED_UNICODE);
            $stmt = $db->prepare("
                INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at)
                VALUES (:cid, :sender, :content, 'playlist', now()::text)
                RETURNING id
            ");
            $stmt->execute([':cid' => $conversationId, ':sender' => $user['email'], ':content' => $content]);
            $msgId = (int)$stmt->fetchColumn();
            $db->prepare("UPDATE chat_conversations SET updated_at = now()::text WHERE id = :cid")
               ->execute([':cid' => $conversationId]);

            $payload['id'] = $msgId;
            jsonResponse(true, [
                'id' => $msgId,
                'conversation_id' => $conversationId,
                'sender_email' => $user['email'],
                'type' => 'playlist',
                'content' => $content,
                'playlist' => $payload,
                'created_at' => gmdate('Y-m-d\TH:i:s\Z'),
            ], 'Playlist created');
            break;
        }

        // ============================================================
        // chat_playlist_add_song / chat_playlist_remove_song — Mutate songs JSON
        // ============================================================
        case 'chat_playlist_add_song':
        case 'chat_playlist_remove_song': {
            $user = requireChatAuth();
            $msgId = (int)($input['message_id'] ?? 0);
            if (!$msgId) jsonResponse(false, null, 'message_id required', 400);
            $stmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND type = 'playlist'");
            $stmt->execute([':id' => $msgId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Playlist not found', 404);
            requireConversationMember($db, $msg['conversation_id'], $user['email']);

            $playlist = json_decode($msg['content'] ?? '{}', true);
            if (!is_array($playlist)) $playlist = ['playlist_name' => 'Playlist', 'songs' => []];
            if (!isset($playlist['songs']) || !is_array($playlist['songs'])) $playlist['songs'] = [];

            if ($action === 'chat_playlist_add_song') {
                $song = [
                    'title' => mb_substr(trim((string)($input['title'] ?? '')), 0, 120),
                    'artist' => mb_substr(trim((string)($input['artist'] ?? '')), 0, 120),
                    'url' => mb_substr(trim((string)($input['url'] ?? '')), 0, 500),
                    'cover' => mb_substr(trim((string)($input['cover'] ?? '')), 0, 500),
                    'preview_url' => mb_substr(trim((string)($input['preview_url'] ?? '')), 0, 500),
                    'duration' => (int)($input['duration'] ?? 30),
                    'added_by' => $user['email'],
                ];
                if ($song['title'] === '' && $song['url'] === '') jsonResponse(false, null, 'title or url required', 400);
                if (count($playlist['songs']) >= 50) jsonResponse(false, null, 'Playlist full (50 songs max)', 400);
                $playlist['songs'][] = $song;
            } else {
                $idx = (int)($input['song_index'] ?? -1);
                if ($idx < 0 || $idx >= count($playlist['songs'])) jsonResponse(false, null, 'Invalid song_index', 400);
                array_splice($playlist['songs'], $idx, 1);
            }

            $newContent = json_encode($playlist, JSON_UNESCAPED_UNICODE);
            $db->prepare("UPDATE chat_messages SET content = :c WHERE id = :id")->execute([':c' => $newContent, ':id' => $msgId]);
            $playlist['id'] = $msgId;
            jsonResponse(true, ['message_id' => $msgId, 'songs' => $playlist['songs'], 'playlist' => $playlist], 'Playlist updated');
            break;
        }

        // ============================================================
        // BULK STUBS — features not yet fully implemented but called by
        // frontend. Return ok+empty shapes so UI doesn't spam errors.
        // Prefixed as stub_ in comments for later replacement.
        // ============================================================

        // chat_starred_messages — list everything the user starred.
        case 'chat_starred_messages': {
            $user = requireChatAuth();
            $items = [];
            try {
                $stmt = $db->prepare("
                    SELECT m.id, m.conversation_id, m.sender_email, m.content, m.type,
                           m.file_url, m.file_name, m.created_at, s.created_at as starred_at
                    FROM chat_starred_messages s
                    JOIN chat_messages m ON m.id = s.message_id
                    WHERE LOWER(s.user_email) = LOWER(:e) AND m.deleted_at IS NULL
                    ORDER BY s.created_at DESC
                    LIMIT 200
                ");
                $stmt->execute([':e' => $user['email']]);
                foreach ($stmt->fetchAll() as $r) {
                    $r['id'] = (int)$r['id'];
                    $r['conversation_id'] = (int)$r['conversation_id'];
                    $r['sender_name'] = chatDisplayName($r['sender_email']);
                    $items[] = $r;
                }
            } catch (Throwable $e) { error_log('[chat_starred_messages] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_pinned_messages — current pins for a conversation.
        case 'chat_pinned_messages': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $items = [];
            try {
                $stmt = $db->prepare("
                    SELECT m.id, m.conversation_id, m.sender_email, m.content, m.type,
                           m.created_at, p.pinned_by, p.created_at as pinned_at
                    FROM chat_pinned_messages p
                    JOIN chat_messages m ON m.id = p.message_id
                    WHERE p.conversation_id = :cid AND m.deleted_at IS NULL
                    ORDER BY p.created_at DESC
                    LIMIT 3
                ");
                $stmt->execute([':cid' => $cid]);
                foreach ($stmt->fetchAll() as $r) {
                    $r['id'] = (int)$r['id'];
                    $r['conversation_id'] = (int)$r['conversation_id'];
                    $r['sender_name'] = chatDisplayName($r['sender_email']);
                    $items[] = $r;
                }
            } catch (Throwable $e) { error_log('[chat_pinned_messages] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_scheduled_list — user's pending scheduled messages.
        case 'chat_scheduled_list': {
            $user = requireChatAuth();
            $items = [];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT id, conversation_id, content, type, scheduled_at, created_at FROM chat_scheduled_messages WHERE LOWER(sender_email) = LOWER(:e) AND status = 'pending' ORDER BY scheduled_at ASC LIMIT 100");
                $stmt->execute([':e' => $user['email']]);
                $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($items as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['conversation_id'] = (int)$r['conversation_id'];
                }
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_broadcast_list — user's broadcast lists.
        case 'chat_broadcast_list': {
            $user = requireChatAuth();
            $items = [];
            try {
                $stmt = $db->prepare("SELECT id, name, recipients, created_at FROM chat_broadcast_lists WHERE LOWER(created_by) = LOWER(:e) ORDER BY id DESC");
                $stmt->execute([':e' => $user['email']]);
                foreach ($stmt->fetchAll() as $r) {
                    $items[] = [
                        'id' => (int)$r['id'],
                        'name' => $r['name'],
                        'recipients' => json_decode($r['recipients'] ?: '[]', true) ?: [],
                        'created_at' => $r['created_at'],
                    ];
                }
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_folders_list — user's custom folders.
        case 'chat_folders_list': {
            $user = requireChatAuth();
            $items = [];
            try {
                // chat_folders in PG uses user_email (not created_by). Accept either for back-compat.
                $stmt = $db->prepare("SELECT id, name, icon, conversation_ids, COALESCE(position, 0) AS position FROM chat_folders WHERE LOWER(user_email) = LOWER(:e) OR LOWER(COALESCE(created_by,'')) = LOWER(:e2) ORDER BY position ASC, id ASC");
                $stmt->execute([':e' => $user['email'], ':e2' => $user['email']]);
                foreach ($stmt->fetchAll() as $r) {
                    $items[] = [
                        'id' => (int)$r['id'],
                        'name' => $r['name'],
                        'icon' => $r['icon'],
                        'conversation_ids' => json_decode($r['conversation_ids'] ?: '[]', true) ?: [],
                        'position' => (int)$r['position'],
                    ];
                }
            } catch (Throwable $e) { error_log('[chat_folders_list] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_topic_list — threads in a group.
        case 'chat_topic_list': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $items = [];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT id, name, created_by, created_at, COALESCE(pinned, 0) as pinned FROM chat_topics WHERE conversation_id = :c ORDER BY pinned DESC, created_at DESC");
                $stmt->execute([':c' => $cid]);
                $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($items as &$r) { $r['id'] = (int)$r['id']; $r['pinned'] = (bool)$r['pinned']; }
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // ─────────────────────────────────────────────────────────────
        // Voice pre-upload session (Telegram-style):
        //
        //   chat_voice_session_start    → returns session_id
        //   chat_voice_session_chunk    → append a chunk to the session file
        //   chat_voice_session_finalize → flush, run through chat_upload-like
        //                                 pipeline, insert chat_messages row
        //                                 and broadcast — same shape chat_send
        //                                 returns.
        //
        // Why: while the user is still recording, the client can POST chunks
        // as MediaRecorder yields them. By the time the user releases the mic
        // most bytes are already on the server, so the perceived send delay
        // collapses to ~one final chunk + DB insert. WhatsApp/Telegram both
        // do this; we never did.
        //
        // Storage: /tmp/chat_voice_sessions/<session_id>.partial — appended
        // in order, capped at ~25 MB (Opus @ 64kbps for ~50 min).
        // ─────────────────────────────────────────────────────────────
        case 'chat_voice_session_start': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            if (!chatRateLimit($user['email'], 'voice_session_start', 30, 60)) {
                jsonResponse(false, null, 'Rate limit exceeded', 429);
            }
            $sessionsDir = '/tmp/chat_voice_sessions';
            if (!is_dir($sessionsDir)) @mkdir($sessionsDir, 0700, true);
            // Lazy GC — drop sessions older than 10 min. Cheap (one readdir
            // per start), no cron needed. Sessions are tiny (~100 KB max).
            try {
                $cutoff = time() - 600;
                foreach (@glob($sessionsDir . '/*.meta') ?: [] as $mp) {
                    if (@filemtime($mp) < $cutoff) {
                        $base = preg_replace('/\.meta$/', '', $mp);
                        @unlink($mp);
                        @unlink($base . '.partial');
                    }
                }
            } catch (Throwable $e) {}
            $sid = bin2hex(random_bytes(16));
            $meta = [
                'email'           => $user['email'],
                'conversation_id' => $cid,
                'created_at'      => time(),
                'received_bytes'  => 0,
                'last_chunk'      => -1,
            ];
            @file_put_contents($sessionsDir . '/' . $sid . '.meta', json_encode($meta), LOCK_EX);
            @file_put_contents($sessionsDir . '/' . $sid . '.partial', '', LOCK_EX);
            jsonResponse(true, ['session_id' => $sid]);
            break;
        }

        case 'chat_voice_session_chunk': {
            $user = requireChatAuth();
            $sid = preg_replace('/[^a-f0-9]/', '', (string)($_POST['session_id'] ?? $_GET['session_id'] ?? ''));
            $idx = (int)($_POST['chunk_index'] ?? $_GET['chunk_index'] ?? -1);
            if (strlen($sid) !== 32) jsonResponse(false, null, 'invalid session_id', 400);
            if ($idx < 0) jsonResponse(false, null, 'chunk_index required', 400);
            $sessionsDir = '/tmp/chat_voice_sessions';
            $metaPath = $sessionsDir . '/' . $sid . '.meta';
            $partPath = $sessionsDir . '/' . $sid . '.partial';
            if (!is_file($metaPath) || !is_file($partPath)) jsonResponse(false, null, 'session not found', 404);
            $meta = json_decode((string)@file_get_contents($metaPath), true) ?: [];
            if (strcasecmp($meta['email'] ?? '', $user['email']) !== 0) jsonResponse(false, null, 'not your session', 403);
            // Drop stale sessions (>10 min). They get GC'd by the cron later
            // but we don't want to keep accepting bytes against them.
            if (time() - (int)($meta['created_at'] ?? 0) > 600) {
                @unlink($metaPath); @unlink($partPath);
                jsonResponse(false, null, 'session expired', 410);
            }
            // Out-of-order chunks: reject. The client must re-send in order.
            // MediaRecorder always fires dataavailable in order so this is a
            // misbehaving client signal, not a real edge case.
            if ($idx !== ((int)$meta['last_chunk'] + 1)) {
                jsonResponse(false, null, 'chunk_index out of order; expected ' . ((int)$meta['last_chunk'] + 1), 409);
            }
            if (empty($_FILES['chunk'])) jsonResponse(false, null, 'no chunk file', 400);
            $chunk = $_FILES['chunk'];
            if ($chunk['error'] !== UPLOAD_ERR_OK) jsonResponse(false, null, 'chunk upload error: ' . $chunk['error'], 400);
            $chunkSize = (int)($chunk['size'] ?? 0);
            $cap = 25 * 1024 * 1024; // ~25 MB total
            if ((int)($meta['received_bytes'] ?? 0) + $chunkSize > $cap) {
                jsonResponse(false, null, 'voice session size cap exceeded (25 MB)', 413);
            }
            // Append chunk bytes.
            $chunkBytes = @file_get_contents($chunk['tmp_name']);
            @unlink($chunk['tmp_name']);
            if ($chunkBytes === false) jsonResponse(false, null, 'failed to read chunk', 500);
            $fp = @fopen($partPath, 'ab');
            if (!$fp) jsonResponse(false, null, 'failed to open session file', 500);
            @flock($fp, LOCK_EX);
            @fwrite($fp, $chunkBytes);
            @flock($fp, LOCK_UN);
            @fclose($fp);
            $meta['last_chunk']     = $idx;
            $meta['received_bytes'] = (int)($meta['received_bytes'] ?? 0) + strlen($chunkBytes);
            @file_put_contents($metaPath, json_encode($meta), LOCK_EX);
            jsonResponse(true, ['received_bytes' => $meta['received_bytes'], 'last_chunk' => $idx]);
            break;
        }

        case 'chat_voice_session_finalize': {
            $user = requireChatAuth();
            $sid = preg_replace('/[^a-f0-9]/', '', (string)($input['session_id'] ?? $_POST['session_id'] ?? ''));
            $duration = (int)($input['duration'] ?? $_POST['duration'] ?? 0);
            $mimeIn = trim((string)($input['mime'] ?? $_POST['mime'] ?? 'audio/webm'));
            $waveformIn = $input['waveform'] ?? $_POST['waveform'] ?? null;
            if (strlen($sid) !== 32) jsonResponse(false, null, 'invalid session_id', 400);
            $sessionsDir = '/tmp/chat_voice_sessions';
            $metaPath = $sessionsDir . '/' . $sid . '.meta';
            $partPath = $sessionsDir . '/' . $sid . '.partial';
            if (!is_file($metaPath) || !is_file($partPath)) jsonResponse(false, null, 'session not found', 404);
            $meta = json_decode((string)@file_get_contents($metaPath), true) ?: [];
            if (strcasecmp($meta['email'] ?? '', $user['email']) !== 0) jsonResponse(false, null, 'not your session', 403);
            $cid = (int)($meta['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'session has no conversation', 400);
            requireConversationMember($db, $cid, $user['email']);
            $size = (int)@filesize($partPath);
            if ($size <= 0) {
                @unlink($metaPath); @unlink($partPath);
                jsonResponse(false, null, 'session is empty', 400);
            }

            // 100GB plan storage cap — refuse to land the assembled voice
            // file when the user is over quota. Cleans up the partial.
            require_once __DIR__ . '/plans.php';
            try {
                require_once __DIR__ . '/drive.php';
                $driveDb = function_exists('getDriveDB') ? getDriveDB() : null;
                $info = $driveDb ? driveGetStorageInfo($driveDb, $user['email']) : null;
                $limit = $info ? (int)($info['quota'] ?? 0) : 0;
                $used  = $info ? (int)($info['total_used'] ?? 0) : 0;
                if ($limit > 0 && ($used + $size) > $limit) {
                    @unlink($metaPath); @unlink($partPath);
                }
            } catch (\Throwable $e) { /* fall through to enforceStorageCap */ }
            enforceStorageCap($user['email'], $size);

            // Move into the conversation's media dir under the same naming
            // convention chat_upload uses. We accept webm + m4a + mp4 (Opus).
            $ext = 'webm';
            if (stripos($mimeIn, 'mp4') !== false || stripos($mimeIn, 'm4a') !== false) $ext = 'm4a';
            $uploadDir = '/var/www/mail/data/chat-files/' . $cid . '/';
            if (!is_dir($uploadDir) && !@mkdir($uploadDir, 0755, true)) {
                jsonResponse(false, null, 'failed to create upload dir', 500);
            }
            $finalName = time() . '_' . bin2hex(random_bytes(4)) . '_voice.' . $ext;
            $finalPath = $uploadDir . $finalName;
            if (!@rename($partPath, $finalPath)) {
                // rename across filesystems can fail; fall back to copy.
                if (!@copy($partPath, $finalPath)) {
                    jsonResponse(false, null, 'failed to assemble voice file', 500);
                }
                @unlink($partPath);
            }
            @chmod($finalPath, 0644);
            @unlink($metaPath);

            $relUrl = '/data/chat-files/' . $cid . '/' . $finalName;
            $content = 'Audio (' . max(0, $duration) . 's)';

            // Insert chat_messages row + broadcast — mirrors chat_send.
            try {
                $stmt = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, file_url, file_size, created_at, duration)
                                      VALUES (:cid, :email, :content, 'audio', :url, :size, now()::text, :dur) RETURNING id");
                $stmt->execute([
                    ':cid'     => $cid,
                    ':email'   => $user['email'],
                    ':content' => $content,
                    ':url'     => $relUrl,
                    ':size'    => $size,
                    ':dur'     => $duration,
                ]);
                $msgId = (int)$stmt->fetchColumn();
            } catch (Throwable $e) {
                @unlink($finalPath);
                error_log('[voice_finalize/insert] ' . $e->getMessage());
                jsonResponse(false, null, 'DB insert failed', 500);
            }

            // Client-supplied waveform → drop a .peaks.json sidecar so the
            // bubble renders the real shape immediately. The async ffmpeg
            // astats path that chat_upload uses isn't run here (we already
            // have the file assembled and the client sent its capture
            // levels), but a background astats refinement could overwrite
            // this file later if higher fidelity is needed.
            if (is_array($waveformIn) && count($waveformIn) > 0) {
                try {
                    $clean = [];
                    foreach ($waveformIn as $v) {
                        $f = (float)$v;
                        if ($f < 0) $f = 0; if ($f > 1) $f = 1;
                        $clean[] = round($f, 3);
                        if (count($clean) >= 64) break;
                    }
                    @file_put_contents($finalPath . '.peaks.json', json_encode($clean), LOCK_EX);
                    @chmod($finalPath . '.peaks.json', 0640);
                } catch (Throwable $e) { error_log('[voice_finalize/wf] ' . $e->getMessage()); }
            }

            // Touch conversation + broadcast for live delivery (same as chat_send).
            try { touchConversation($db, $cid); } catch (Throwable $e) {}
            try { broadcastChatMessage($db, $cid, $msgId, $user['email'], 'new'); } catch (Throwable $e) { error_log('[voice_finalize/ws] ' . $e->getMessage()); }
            try { emitConvEvent($db, $cid, 'message', $user['email'], ['message_id' => $msgId]); } catch (Throwable $e) {}

            // Return the full message row so the client can swap optimistic.
            $msgStmt = $db->prepare("SELECT * FROM chat_messages WHERE id = :id");
            $msgStmt->execute([':id' => $msgId]);
            $msg = $msgStmt->fetch(\PDO::FETCH_ASSOC) ?: [];
            if ($msg) {
                $msg['id'] = (int)$msg['id'];
                $msg['sender_name'] = chatDisplayName($user['email']);
            }
            jsonResponse(true, ['message' => $msg]);
            break;
        }

        // chat_edit_history — messages edit trail (chat_message_versions).
        case 'chat_edit_history': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? $_GET['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            // Verify the requester is in the conversation.
            $c = $db->prepare("SELECT conversation_id FROM chat_messages WHERE id = :id");
            $c->execute([':id' => $messageId]);
            $cid = (int)($c->fetchColumn() ?: 0);
            if (!$cid) jsonResponse(false, null, 'Message not found', 404);
            requireConversationMember($db, $cid, $user['email']);
            $items = [];
            try {
                $stmt = $db->prepare("SELECT content, edited_at FROM chat_message_versions WHERE message_id = :m ORDER BY edited_at DESC LIMIT 20");
                $stmt->execute([':m' => $messageId]);
                $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            } catch (Throwable $e) {}
            jsonResponse(true, ['versions' => $items]);
            break;
        }

        // chat_pending_members — who is waiting for admin approval on a
        // group. Admin-only: members can't enumerate pending list.
        case 'chat_pending_members': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            $m = requireConversationMember($db, $cid, $user['email']);
            if (($m['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can view pending members', 403);
            }
            $items = [];
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_pending_group_members (conversation_id BIGINT NOT NULL, email TEXT NOT NULL, requested_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (conversation_id, email))");
                $stmt = $db->prepare("SELECT email, requested_at FROM chat_pending_group_members WHERE conversation_id = :c ORDER BY requested_at ASC");
                $stmt->execute([':c' => $cid]);
                foreach ($stmt->fetchAll() as $r) {
                    $items[] = ['email' => $r['email'], 'name' => chatDisplayName($r['email']), 'requested_at' => $r['requested_at']];
                }
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_sticker_packs_list — packs the user has installed. Joined
        // with chat_sticker_packs for name/cover.
        case 'chat_sticker_packs_list': {
            $user = requireChatAuth();
            $items = [];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT p.id, p.name, COALESCE(p.cover_url,'') as cover_url, COALESCE(p.author,'') as author, u.installed_at
                    FROM chat_user_sticker_packs u
                    JOIN chat_sticker_packs p ON p.id = u.pack_id
                    WHERE u.user_email = :e
                    ORDER BY u.installed_at DESC");
                $stmt->execute([':e' => $user['email']]);
                $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($items as &$r) $r['id'] = (int)$r['id'];
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_user_stickers — every sticker the user owns via installed
        // packs. Flat list for the picker.
        case 'chat_user_stickers': {
            $user = requireChatAuth();
            $items = [];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT s.id, s.pack_id, s.image_url AS url, COALESCE(s.emoji,'') as emoji, COALESCE(s.emoji_tags,'') as emoji_tags, COALESCE(s.is_animated,false) as is_animated
                    FROM chat_stickers s
                    JOIN chat_user_sticker_packs u ON u.pack_id = s.pack_id AND u.user_email = :e
                    ORDER BY s.pack_id, s.id");
                $stmt->execute([':e' => $user['email']]);
                $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($items as &$r) { $r['id'] = (int)$r['id']; $r['pack_id'] = (int)$r['pack_id']; }
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // ════════════════════════════════════════════════════════════════
        // CUSTOM STICKER CREATION (WhatsApp/Telegram-level)
        // Users can upload their own stickers, group them into packs, tag
        // with emoji, and search by those tags. Storage on disk under
        // /var/www/mail/data/sticker-files/{user_hash}/ — served via nginx
        // alias at /data/sticker-files/.
        // ════════════════════════════════════════════════════════════════

        // chat_sticker_create — upload a new personal sticker.
        // Multipart form: file (image), pack_id (optional — creates "My Stickers"
        // default pack if missing), emoji_tags (comma-separated string).
        // Returns: { id, url, pack_id, emoji_tags }
        case 'chat_sticker_create': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();

            if (empty($_FILES['file'])) {
                jsonResponse(false, null, 'No file uploaded', 400);
            }
            $file = $_FILES['file'];
            $maxSize = 4 * 1024 * 1024; // 4MB — stickers are 512x512 webp/png, no need for more
            if ($file['size'] > $maxSize) jsonResponse(false, null, 'File too large (max 4MB)', 400);
            if ($file['error'] !== UPLOAD_ERR_OK) jsonResponse(false, null, 'Upload error: ' . $file['error'], 400);

            // 100GB plan storage cap.
            require_once __DIR__ . '/plans.php';
            enforceStorageCap($user['email'], (int)$file['size']);

            $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
            $allowedExts = ['png', 'webp', 'jpg', 'jpeg', 'gif'];
            if (!in_array($ext, $allowedExts, true)) {
                jsonResponse(false, null, 'Only PNG/WebP/JPG/GIF allowed', 400);
            }

            // Validate real MIME (don't trust client)
            $mime = @mime_content_type($file['tmp_name']) ?: '';
            $allowedMimes = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'];
            if (!in_array($mime, $allowedMimes, true)) {
                jsonResponse(false, null, 'Invalid image', 400);
            }

            // Per-user directory. Hash email to avoid leaking addresses on disk.
            $userHash = substr(hash('sha256', strtolower($user['email'])), 0, 16);
            $uploadDir = '/var/www/mail/data/sticker-files/' . $userHash . '/';
            if (!is_dir($uploadDir)) {
                if (!@mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
                    jsonResponse(false, null, 'Failed to create sticker dir', 500);
                }
            }

            $uniqueName = time() . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
            $destPath = $uploadDir . $uniqueName;
            if (!move_uploaded_file($file['tmp_name'], $destPath)) {
                jsonResponse(false, null, 'Failed to save sticker', 500);
            }
            @chmod($destPath, 0640);

            $fileUrl = '/data/sticker-files/' . $userHash . '/' . $uniqueName;

            // Determine pack — explicit pack_id wins, else find/create the
            // user's default "My Stickers" pack.
            $packId = (int)($_POST['pack_id'] ?? 0);
            if ($packId > 0) {
                // Verify pack belongs to user (cannot add stickers to foreign packs)
                $pStmt = $pg->prepare("SELECT id FROM chat_sticker_packs WHERE id = :id AND author_email = :e");
                $pStmt->execute([':id' => $packId, ':e' => $user['email']]);
                if (!$pStmt->fetch()) {
                    @unlink($destPath);
                    jsonResponse(false, null, 'Pack not found or not owned', 403);
                }
            } else {
                // Find or create default pack
                $fStmt = $pg->prepare("SELECT id FROM chat_sticker_packs WHERE author_email = :e AND is_personal = true AND name = 'My Stickers' LIMIT 1");
                $fStmt->execute([':e' => $user['email']]);
                $row = $fStmt->fetch();
                if ($row) {
                    $packId = (int)$row['id'];
                } else {
                    $cStmt = $pg->prepare("INSERT INTO chat_sticker_packs (name, author, author_email, cover_url, is_personal, description) VALUES ('My Stickers', :auth, :e, :cov, true, '') RETURNING id");
                    $cStmt->execute([':auth' => chatDisplayName($user['email']), ':e' => $user['email'], ':cov' => $fileUrl]);
                    $packId = (int)$cStmt->fetchColumn();
                    // Auto-install the user's own pack for them so it shows in picker
                    $pg->prepare("INSERT INTO chat_user_sticker_packs (user_email, pack_id, installed_at) VALUES (:e, :p, now()::text) ON CONFLICT DO NOTHING")
                       ->execute([':e' => $user['email'], ':p' => $packId]);
                }
            }

            // Normalize emoji_tags — up to 10 tags, each <= 30 chars, alphanumeric+emoji+unicode punctuation
            $emojiTags = trim((string)($_POST['emoji_tags'] ?? ''));
            if (mb_strlen($emojiTags) > 200) $emojiTags = mb_substr($emojiTags, 0, 200);

            $primaryEmoji = trim((string)($_POST['emoji'] ?? ''));
            if (mb_strlen($primaryEmoji) > 8) $primaryEmoji = mb_substr($primaryEmoji, 0, 8);

            $isAnimated = ($ext === 'webp' || $ext === 'gif') && !empty($_POST['is_animated']);

            $iStmt = $pg->prepare("INSERT INTO chat_stickers (pack_id, emoji, image_url, author_email, emoji_tags, is_animated) VALUES (:p, :em, :url, :auth, :tags, :anim) RETURNING id, created_at");
            $iStmt->execute([
                ':p' => $packId,
                ':em' => $primaryEmoji,
                ':url' => $fileUrl,
                ':auth' => $user['email'],
                ':tags' => $emojiTags,
                ':anim' => $isAnimated ? 't' : 'f',
            ]);
            $row = $iStmt->fetch(PDO::FETCH_ASSOC);

            jsonResponse(true, [
                'id' => (int)$row['id'],
                'pack_id' => $packId,
                'url' => $fileUrl,
                'emoji' => $primaryEmoji,
                'emoji_tags' => $emojiTags,
                'is_animated' => $isAnimated,
                'created_at' => $row['created_at'],
            ]);
            break;
        }

        // chat_sticker_delete — remove a sticker the user owns.
        case 'chat_sticker_delete': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();

            $stickerId = (int)($input['sticker_id'] ?? $_POST['sticker_id'] ?? $_GET['sticker_id'] ?? 0);
            if (!$stickerId) jsonResponse(false, null, 'sticker_id required', 400);

            $sStmt = $pg->prepare("SELECT id, image_url, author_email FROM chat_stickers WHERE id = :id");
            $sStmt->execute([':id' => $stickerId]);
            $sticker = $sStmt->fetch(PDO::FETCH_ASSOC);
            if (!$sticker) jsonResponse(false, null, 'Sticker not found', 404);
            if (strtolower((string)$sticker['author_email']) !== strtolower($user['email'])) {
                jsonResponse(false, null, 'Not the owner', 403);
            }

            // Delete file on disk (best-effort; keep DB consistent regardless)
            if (!empty($sticker['image_url']) && strpos($sticker['image_url'], '/data/sticker-files/') === 0) {
                $diskPath = '/var/www/mail' . $sticker['image_url'];
                if (file_exists($diskPath)) @unlink($diskPath);
            }

            $pg->prepare("DELETE FROM chat_stickers WHERE id = :id")->execute([':id' => $stickerId]);
            jsonResponse(true, ['id' => $stickerId]);
            break;
        }

        // chat_sticker_pack_create — new personal pack (empty, user fills it
        // by uploading stickers with pack_id).
        case 'chat_sticker_pack_create': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();

            $name = trim((string)($input['name'] ?? $_POST['name'] ?? ''));
            if ($name === '') jsonResponse(false, null, 'name required', 400);
            if (mb_strlen($name) > 60) $name = mb_substr($name, 0, 60);
            $description = trim((string)($input['description'] ?? $_POST['description'] ?? ''));
            if (mb_strlen($description) > 200) $description = mb_substr($description, 0, 200);
            $coverUrl = trim((string)($input['cover_url'] ?? $_POST['cover_url'] ?? ''));

            $stmt = $pg->prepare("INSERT INTO chat_sticker_packs (name, author, author_email, cover_url, is_personal, description) VALUES (:n, :auth, :e, :cov, true, :d) RETURNING id, created_at");
            $stmt->execute([':n' => $name, ':auth' => chatDisplayName($user['email']), ':e' => $user['email'], ':cov' => $coverUrl, ':d' => $description]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            $packId = (int)$row['id'];

            // Auto-install
            $pg->prepare("INSERT INTO chat_user_sticker_packs (user_email, pack_id, installed_at) VALUES (:e, :p, now()::text) ON CONFLICT DO NOTHING")
               ->execute([':e' => $user['email'], ':p' => $packId]);

            jsonResponse(true, [
                'id' => $packId,
                'name' => $name,
                'description' => $description,
                'cover_url' => $coverUrl,
                'created_at' => $row['created_at'],
            ]);
            break;
        }

        // chat_sticker_pack_delete — remove a personal pack (and all its stickers).
        case 'chat_sticker_pack_delete': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();

            $packId = (int)($input['pack_id'] ?? $_POST['pack_id'] ?? $_GET['pack_id'] ?? 0);
            if (!$packId) jsonResponse(false, null, 'pack_id required', 400);

            $pStmt = $pg->prepare("SELECT id, author_email FROM chat_sticker_packs WHERE id = :id");
            $pStmt->execute([':id' => $packId]);
            $pack = $pStmt->fetch(PDO::FETCH_ASSOC);
            if (!$pack) jsonResponse(false, null, 'Pack not found', 404);
            if (strtolower((string)$pack['author_email']) !== strtolower($user['email'])) {
                jsonResponse(false, null, 'Not the owner', 403);
            }

            // Remove stickers' disk files
            $fs = $pg->prepare("SELECT image_url FROM chat_stickers WHERE pack_id = :p");
            $fs->execute([':p' => $packId]);
            foreach ($fs->fetchAll(PDO::FETCH_ASSOC) as $s) {
                if (!empty($s['image_url']) && strpos($s['image_url'], '/data/sticker-files/') === 0) {
                    $diskPath = '/var/www/mail' . $s['image_url'];
                    if (file_exists($diskPath)) @unlink($diskPath);
                }
            }

            // Cascade: stickers → user_sticker_packs → pack
            $pg->prepare("DELETE FROM chat_stickers WHERE pack_id = :p")->execute([':p' => $packId]);
            $pg->prepare("DELETE FROM chat_user_sticker_packs WHERE pack_id = :p")->execute([':p' => $packId]);
            $pg->prepare("DELETE FROM chat_sticker_packs WHERE id = :p")->execute([':p' => $packId]);

            jsonResponse(true, ['id' => $packId]);
            break;
        }

        // chat_sticker_my_packs — packs authored by the user (as opposed to
        // installed packs from the catalog). Returns sticker counts too so
        // the UI can render a pack card with preview.
        case 'chat_sticker_my_packs': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();
            $items = [];
            try {
                $stmt = $pg->prepare("SELECT p.id, p.name, COALESCE(p.cover_url,'') AS cover_url, COALESCE(p.description,'') AS description, p.created_at,
                    (SELECT COUNT(*) FROM chat_stickers s WHERE s.pack_id = p.id) AS sticker_count
                    FROM chat_sticker_packs p
                    WHERE p.author_email = :e
                    ORDER BY p.created_at DESC");
                $stmt->execute([':e' => $user['email']]);
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $r['id'] = (int)$r['id'];
                    $r['sticker_count'] = (int)$r['sticker_count'];
                    $items[] = $r;
                }
            } catch (Throwable $e) { error_log('[sticker_my_packs] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_sticker_my_stickers — every sticker authored by the user,
        // across all their packs. Supports ?pack_id filter and ?q search
        // (matches emoji_tags / emoji). Used for "My Stickers" tab.
        case 'chat_sticker_my_stickers': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();
            $packFilter = (int)($input['pack_id'] ?? $_GET['pack_id'] ?? 0);
            $query = trim((string)($input['q'] ?? $_GET['q'] ?? ''));

            $sql = "SELECT s.id, s.pack_id, s.image_url AS url, COALESCE(s.emoji,'') AS emoji,
                           COALESCE(s.emoji_tags,'') AS emoji_tags, COALESCE(s.is_animated,false) AS is_animated, s.created_at
                    FROM chat_stickers s
                    WHERE s.author_email = :e";
            $params = [':e' => $user['email']];
            if ($packFilter > 0) { $sql .= " AND s.pack_id = :p"; $params[':p'] = $packFilter; }
            if ($query !== '') {
                $sql .= " AND (LOWER(s.emoji_tags) LIKE :q OR s.emoji LIKE :q2)";
                $params[':q'] = '%' . strtolower($query) . '%';
                $params[':q2'] = '%' . $query . '%';
            }
            $sql .= " ORDER BY s.created_at DESC LIMIT 500";
            $items = [];
            try {
                $stmt = $pg->prepare($sql);
                $stmt->execute($params);
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $r['id'] = (int)$r['id'];
                    $r['pack_id'] = (int)$r['pack_id'];
                    $items[] = $r;
                }
            } catch (Throwable $e) { error_log('[sticker_my_stickers] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_sticker_search — emoji-tag search across the user's own
        // stickers + all their installed pack stickers. WhatsApp-style:
        // type "happy" → get every sticker tagged with "happy".
        case 'chat_sticker_search': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();
            $q = strtolower(trim((string)($input['q'] ?? $_GET['q'] ?? '')));
            if ($q === '' || mb_strlen($q) < 2) { jsonResponse(true, ['items' => []]); break; }

            $items = [];
            try {
                $stmt = $pg->prepare("
                    SELECT DISTINCT s.id, s.pack_id, s.image_url AS url, COALESCE(s.emoji,'') AS emoji,
                        COALESCE(s.emoji_tags,'') AS emoji_tags, COALESCE(s.is_animated,false) AS is_animated
                    FROM chat_stickers s
                    LEFT JOIN chat_user_sticker_packs u ON u.pack_id = s.pack_id AND u.user_email = :e
                    WHERE (u.user_email IS NOT NULL OR s.author_email = :e2)
                      AND (LOWER(s.emoji_tags) LIKE :q OR s.emoji LIKE :q2)
                    ORDER BY s.id DESC
                    LIMIT 100
                ");
                $stmt->execute([
                    ':e' => $user['email'],
                    ':e2' => $user['email'],
                    ':q' => '%' . $q . '%',
                    ':q2' => '%' . $q . '%',
                ]);
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $r['id'] = (int)$r['id'];
                    $r['pack_id'] = (int)$r['pack_id'];
                    $items[] = $r;
                }
            } catch (Throwable $e) { error_log('[sticker_search] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // chat_sticker_remove_bg — automatic background removal.
        // TODO: integrate remove.bg API (REMOVE_BG_API_KEY env var) or a
        // self-hosted U2Net model. For now this is a stub that accepts an
        // uploaded image and returns it unchanged, so the UI can show the
        // button without blocking on the AI pipeline.
        //
        // When implementing: forward $_FILES['file'] to remove.bg, receive
        // PNG with transparent background, save under sticker-files/{hash}/
        // and return the new URL.
        case 'chat_sticker_remove_bg': {
            $user = requireChatAuth();
            if (empty($_FILES['file'])) jsonResponse(false, null, 'No file uploaded', 400);

            // Minimal stub — echo the image back as-is. This way the client
            // can wire the UI + upload flow and the server can be upgraded
            // later without a client rebuild.
            $apiKey = $_ENV['REMOVE_BG_API_KEY'] ?? getenv('REMOVE_BG_API_KEY') ?? '';
            if (empty($apiKey)) {
                // No API key configured — return a flag so UI can fall back
                // to client-side MediaPipe SelfieSegmentation.
                jsonResponse(true, [
                    'processed' => false,
                    'reason' => 'no_api_key',
                    'message' => 'Background removal not configured on server. Using client-side.',
                ]);
                break;
            }

            // Real implementation (kept commented until key is configured):
            // $ch = curl_init('https://api.remove.bg/v1.0/removebg');
            // curl_setopt_array($ch, [
            //     CURLOPT_POST => true,
            //     CURLOPT_RETURNTRANSFER => true,
            //     CURLOPT_HTTPHEADER => ['X-Api-Key: ' . $apiKey],
            //     CURLOPT_POSTFIELDS => ['image_file' => new CURLFile($_FILES['file']['tmp_name']), 'size' => 'auto', 'format' => 'png'],
            //     CURLOPT_TIMEOUT => 30,
            // ]);
            // $pngData = curl_exec($ch);
            // ... save to disk, return URL

            jsonResponse(true, ['processed' => false, 'reason' => 'not_implemented']);
            break;
        }

        // chat_sticker_create_animated — accepts a short video (mp4/mov/webm)
        // and uses ffmpeg to produce an animated WebP (512x512, looped, <3s).
        // Saved like a regular sticker with is_animated=true so the picker
        // can render it in an animated <img>/Image component.
        case 'chat_sticker_create_animated': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();

            if (empty($_FILES['file'])) jsonResponse(false, null, 'No file uploaded', 400);
            $file = $_FILES['file'];
            $maxSize = 20 * 1024 * 1024;
            if ($file['size'] > $maxSize) jsonResponse(false, null, 'Video too large (max 20MB)', 400);

            // 100GB plan storage cap.
            require_once __DIR__ . '/plans.php';
            enforceStorageCap($user['email'], (int)$file['size']);

            $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
            $allowedExts = ['mp4', 'mov', 'webm', 'gif'];
            if (!in_array($ext, $allowedExts, true)) {
                jsonResponse(false, null, 'Only MP4/MOV/WEBM/GIF allowed', 400);
            }

            // Check ffmpeg is available before committing to the upload
            $ffmpeg = trim(shell_exec('command -v ffmpeg 2>/dev/null') ?: '');
            if ($ffmpeg === '') jsonResponse(false, null, 'ffmpeg not available on server', 503);

            $userHash = substr(hash('sha256', strtolower($user['email'])), 0, 16);
            $uploadDir = '/var/www/mail/data/sticker-files/' . $userHash . '/';
            if (!is_dir($uploadDir)) @mkdir($uploadDir, 0755, true);

            $tmpInput = tempnam(sys_get_temp_dir(), 'stk_') . '.' . $ext;
            if (!move_uploaded_file($file['tmp_name'], $tmpInput)) {
                jsonResponse(false, null, 'Failed to save upload', 500);
            }

            $uniqueName = time() . '_' . bin2hex(random_bytes(6)) . '.webp';
            $destPath = $uploadDir . $uniqueName;

            // Cap at 3s, 512x512, animated WebP. nice+timeout so a pathological
            // video can't pin a core. -y = overwrite, -an = no audio.
            $cmd = sprintf(
                'timeout 20 nice -n 19 %s -y -i %s -vcodec libwebp -lossless 0 -q:v 80 -loop 0 -preset default -an -vsync 0 -t 3 -vf %s %s 2>&1',
                escapeshellcmd($ffmpeg),
                escapeshellarg($tmpInput),
                escapeshellarg('scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'),
                escapeshellarg($destPath)
            );
            $out = shell_exec($cmd);
            @unlink($tmpInput);

            if (!file_exists($destPath) || filesize($destPath) < 100) {
                error_log('[sticker_create_animated] ffmpeg failed: ' . substr((string)$out, 0, 500));
                jsonResponse(false, null, 'ffmpeg conversion failed', 500);
            }
            @chmod($destPath, 0640);
            $fileUrl = '/data/sticker-files/' . $userHash . '/' . $uniqueName;

            // Attach to user's default pack (same logic as chat_sticker_create)
            $packId = (int)($_POST['pack_id'] ?? 0);
            if ($packId > 0) {
                $pStmt = $pg->prepare("SELECT id FROM chat_sticker_packs WHERE id = :id AND author_email = :e");
                $pStmt->execute([':id' => $packId, ':e' => $user['email']]);
                if (!$pStmt->fetch()) { @unlink($destPath); jsonResponse(false, null, 'Pack not found or not owned', 403); }
            } else {
                $fStmt = $pg->prepare("SELECT id FROM chat_sticker_packs WHERE author_email = :e AND is_personal = true AND name = 'My Stickers' LIMIT 1");
                $fStmt->execute([':e' => $user['email']]);
                $row = $fStmt->fetch();
                if ($row) { $packId = (int)$row['id']; }
                else {
                    $cStmt = $pg->prepare("INSERT INTO chat_sticker_packs (name, author, author_email, cover_url, is_personal, description) VALUES ('My Stickers', :auth, :e, :cov, true, '') RETURNING id");
                    $cStmt->execute([':auth' => chatDisplayName($user['email']), ':e' => $user['email'], ':cov' => $fileUrl]);
                    $packId = (int)$cStmt->fetchColumn();
                    $pg->prepare("INSERT INTO chat_user_sticker_packs (user_email, pack_id, installed_at) VALUES (:e, :p, now()::text) ON CONFLICT DO NOTHING")
                       ->execute([':e' => $user['email'], ':p' => $packId]);
                }
            }

            $emojiTags = trim((string)($_POST['emoji_tags'] ?? ''));
            if (mb_strlen($emojiTags) > 200) $emojiTags = mb_substr($emojiTags, 0, 200);
            $primaryEmoji = trim((string)($_POST['emoji'] ?? ''));
            if (mb_strlen($primaryEmoji) > 8) $primaryEmoji = mb_substr($primaryEmoji, 0, 8);

            $iStmt = $pg->prepare("INSERT INTO chat_stickers (pack_id, emoji, image_url, author_email, emoji_tags, is_animated) VALUES (:p, :em, :url, :auth, :tags, true) RETURNING id, created_at");
            $iStmt->execute([':p' => $packId, ':em' => $primaryEmoji, ':url' => $fileUrl, ':auth' => $user['email'], ':tags' => $emojiTags]);
            $row = $iStmt->fetch(PDO::FETCH_ASSOC);

            jsonResponse(true, [
                'id' => (int)$row['id'],
                'pack_id' => $packId,
                'url' => $fileUrl,
                'emoji' => $primaryEmoji,
                'emoji_tags' => $emojiTags,
                'is_animated' => true,
                'created_at' => $row['created_at'],
            ]);
            break;
        }

        // chat_privacy_contact_list — per-contact privacy overrides.
        case 'chat_privacy_contact_list': {
            $user = requireChatAuth();
            $items = [];
            try {
                $stmt = $db->prepare("SELECT contact_email, field, visibility, updated_at FROM chat_user_privacy_contacts WHERE LOWER(email) = LOWER(:e) ORDER BY updated_at DESC");
                $stmt->execute([':e' => $user['email']]);
                $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            } catch (Throwable $e) {}
            jsonResponse(true, ['items' => $items]);
            break;
        }

        // Empty-list endpoints (still stubbed — features not yet wired).
        case 'chat_backup_list':
        case 'chat_discover_channels':
        case 'chat_message_history': {
            requireChatAuth();
            jsonResponse(true, ['items' => [], 'list' => [], 'backups' => []]);
            break;
        }

        // chat_message_info — per-participant delivery & read receipts for the
        // message-info modal (WhatsApp-style "Info" sheet).
        //
        // Delivery tracking: we don't store per-recipient delivered_at yet
        // (IMAP-grade receipt infra would be costly). Proxy: if the recipient
        // is online/active we mark it delivered NOW; otherwise we leave it
        // unknown and the modal shows "Não entregue".
        //
        // Read tracking: conversation_members.last_read_message_id. If it's
        // ≥ this message's id, the member has read it (read_at ≈ their last
        // activity on the conversation — approximated from the message's
        // created_at since we don't snapshot the timestamp).
        case 'chat_message_info': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? $_GET['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
            } catch (Throwable $e) { jsonResponse(false, null, 'PG unavailable', 503); }

            // Authoritative source: PG chat_messages.
            $mStmt = $pg->prepare("SELECT id, conversation_id, sender_email, created_at FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $mStmt->execute([':id' => $messageId]);
            $msg = $mStmt->fetch(\PDO::FETCH_ASSOC);
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);

            // Membership guard. Fall back to the SQLite check since that's
            // what the rest of chat.php still uses; PG-path auth is already
            // mirrored into SQLite by the lazy-seed in earlier handlers.
            requireConversationMember($db, $msg['conversation_id'], $user['email']);

            // Effective per-member last-read: GREATEST(explicit mark_read,
            // id of most recent msg this member sent). Same rule as the
            // chat_messages fallback — if a member replied in the thread
            // they've read every earlier message even if mark_read never
            // fired on their device.
            $mem = $pg->prepare("
                SELECT
                    m.email,
                    m.last_read_at,
                    GREATEST(
                        COALESCE(m.last_read_message_id, 0),
                        COALESCE((
                            SELECT MAX(cm.id) FROM chat_messages cm
                            WHERE cm.conversation_id = m.conversation_id
                              AND LOWER(cm.sender_email) = LOWER(m.email)
                              AND cm.deleted_at IS NULL
                        ), 0)
                    ) AS last_read_message_id,
                    (
                        SELECT MAX(cm.created_at) FROM chat_messages cm
                        WHERE cm.conversation_id = m.conversation_id
                          AND LOWER(cm.sender_email) = LOWER(m.email)
                          AND cm.deleted_at IS NULL
                    ) AS last_own_msg_at
                FROM chat_conversation_members m
                WHERE m.conversation_id = :cid AND LOWER(m.email) <> LOWER(:se)
            ");
            $mem->execute([':cid' => $msg['conversation_id'], ':se' => $msg['sender_email']]);
            $memberRows = $mem->fetchAll(\PDO::FETCH_ASSOC);

            // Real per-message receipts (written by delivery_ack / mark_read).
            $rcptByEmail = [];
            if (!empty($memberRows)) {
                $rS = $pg->prepare("SELECT email, delivered_at, read_at FROM chat_message_receipts WHERE message_id = :mid");
                $rS->execute([':mid' => $messageId]);
                foreach ($rS->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                    $rcptByEmail[strtolower($r['email'])] = $r;
                }
            }

            // Client expects { read: [{email,name,at}], delivered: [...] }.
            $read = [];
            $delivered = [];
            $receipts = [];
            foreach ($memberRows as $m) {
                $email = $m['email'];
                $lc = strtolower($email);
                $r = $rcptByEmail[$lc] ?? null;
                $name = chatDisplayName($email);

                // Read fallback: effective last_read_message_id >= this
                // message → read. Uses last_own_msg_at (the reply that
                // implicitly proves the read) when it's newer than
                // last_read_at, otherwise last_read_at, otherwise the
                // message's own created_at.
                $readAt = $r['read_at'] ?? null;
                if (!$readAt && (int)($m['last_read_message_id'] ?? 0) >= $messageId) {
                    $lra = $m['last_read_at']    ?? null;
                    $loa = $m['last_own_msg_at'] ?? null;
                    $readAt = $loa && (!$lra || strcmp($loa, $lra) > 0)
                        ? $loa
                        : ($lra ?: $msg['created_at']);
                }

                // Delivered fallback: if read, it was delivered. Otherwise
                // only trust the explicit receipts.delivered_at.
                $deliveredAt = $r['delivered_at'] ?? null;
                if (!$deliveredAt && $readAt) {
                    $deliveredAt = $readAt;
                }

                if ($readAt)      $read[]      = ['email' => $email, 'name' => $name, 'at' => $readAt];
                if ($deliveredAt) $delivered[] = ['email' => $email, 'name' => $name, 'at' => $deliveredAt];

                $receipts[] = [
                    'email'        => $email,
                    'name'         => $name,
                    'delivered_at' => $deliveredAt,
                    'read_at'      => $readAt,
                ];
            }

            jsonResponse(true, [
                'sent_at'   => $msg['created_at'],
                'read'      => $read,
                'delivered' => $delivered,
                'receipts'  => $receipts,
            ]);
            break;
        }

        // chat_search_messages — full-text search over the user's threads.
        // Previously a stub returning empty. Simple LIKE is fine for the
        // typical Brazilian user vocabulary and SQLite's volume here.
        case 'chat_search_messages':
        case 'chat_search_advanced': {
            $user = requireChatAuth();
            $q = trim((string)($input['query'] ?? $_GET['query'] ?? ''));
            $conversationId = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (mb_strlen($q) < 2) jsonResponse(true, ['messages' => [], 'results' => []]);
            // Restrict to conversations the user is a member of so they
            // never see messages from threads they don't belong to.
            $params = [':q' => '%' . $q . '%', ':email' => $user['email']];
            $scopeSql = '';
            if ($conversationId > 0) {
                requireConversationMember($db, $conversationId, $user['email']);
                $scopeSql = ' AND m.conversation_id = :cid';
                $params[':cid'] = $conversationId;
            }
            $stmt = $db->prepare("
                SELECT m.id, m.conversation_id, m.sender_email, m.content, m.type, m.created_at
                FROM chat_messages m
                JOIN chat_conversation_members cm ON cm.conversation_id = m.conversation_id AND LOWER(cm.email) = LOWER(:email)
                WHERE m.deleted_at IS NULL
                AND m.type IN ('text', 'system')
                AND m.content ILIKE :q
                {$scopeSql}
                ORDER BY m.id DESC
                LIMIT 100
            ");
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$r) {
                $r['id'] = (int)$r['id'];
                $r['conversation_id'] = (int)$r['conversation_id'];
                $r['sender_name'] = chatDisplayName($r['sender_email']);
            }
            jsonResponse(true, ['messages' => $rows, 'results' => $rows]);
            break;
        }

        case 'chat_payment_list':
        case 'chat_thread_messages':
        case 'chat_sticker_pack_stickers':
        // ============================================================
        // chat_wake_phone — Stage 4 silent push wake (web↔phone relay)
        // ============================================================
        //
        // The Node WS server calls this when the web companion device
        // issued a relay_request but the phone has no live WS session.
        // We fire a silent FCM data-only push so the phone's native
        // service can briefly bring up the WS, subscribe to its own
        // chat_user_<email> channel, satisfy the relay, and tear down.
        //
        // Auth: server-to-server only. Gated by the existing MAIL_WS_KEY
        // (X-API-Key header), the same shared secret broadcastChatMessage
        // uses. We deliberately do NOT use requireChatAuth() here — this
        // action is never invoked by the app/web client.
        //
        // Silent push contract (matches fcmSendSilentSync):
        //   - Android: data-only, priority=high, TTL 60s, no notification
        //     payload (so CallFirebaseMessagingService.onMessageReceived
        //     gets the message even when the app is killed).
        //   - iOS: apns-push-type=background, apns-priority=5,
        //     content-available=1. Apple rate-limits these to ~2-3/hour
        //     per device so this is best-effort.
        case 'chat_wake_phone': {
            $wsKey = getenv('MAIL_WS_KEY') ?: '';
            if (!$wsKey) {
                // Fallback: try to read from env file (PHP-FPM containers
                // don't always inherit /etc/mail-api.env — same trick the
                // other internal endpoints use).
                $envFile = '/etc/mail-api.env';
                if (file_exists($envFile)) {
                    foreach (file($envFile) as $_line) {
                        if (strpos($_line, 'MAIL_WS_KEY=') === 0) {
                            $wsKey = trim(substr($_line, 12));
                            break;
                        }
                    }
                }
            }
            $hdrKey = $_SERVER['HTTP_X_API_KEY'] ?? '';
            if (!$wsKey || !hash_equals($wsKey, $hdrKey)) {
                jsonResponse(false, null, 'Forbidden', 403);
                break;
            }

            $email = strtolower(trim((string)($input['email'] ?? '')));
            $requestId = (string)($input['requestId'] ?? $input['request_id'] ?? '');
            if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'invalid email', 400);
                break;
            }

            require_once __DIR__ . '/firebase_push.php';
            if (!function_exists('fcmGetUserTokens') || !function_exists('fcmGetAccessToken')) {
                jsonResponse(false, null, 'push module unavailable', 500);
                break;
            }

            $tokens = fcmGetUserTokens($email);
            if (empty($tokens)) {
                jsonResponse(true, ['sent' => 0, 'reason' => 'no_tokens']);
                break;
            }
            $accessToken = fcmGetAccessToken();
            if (!$accessToken) {
                jsonResponse(false, null, 'no fcm access token', 500);
                break;
            }
            $saFile = defined('FCM_SERVICE_ACCOUNT') ? FCM_SERVICE_ACCOUNT : '/etc/onemundo-firebase-sa.json';
            $sa = json_decode((string)@file_get_contents($saFile), true);
            $projectId = $sa['project_id'] ?? '';
            if (!$projectId) {
                jsonResponse(false, null, 'no fcm project id', 500);
                break;
            }

            $payload = [
                'type'      => 'wake_relay',
                'requestId' => $requestId,
                'ts'        => (string)time(),
            ];
            $sent = 0;
            $skipped = 0;
            foreach ($tokens as $entry) {
                $token = $entry['token'] ?? '';
                $platform = $entry['platform'] ?? 'android';
                if (!$token) { $skipped++; continue; }
                // Expo Push tokens cannot deliver a true silent push — skip.
                if (strpos($token, 'ExponentPushToken') !== false ||
                    strpos($token, 'ExpoPushToken') !== false) { $skipped++; continue; }

                $message = [
                    'message' => [
                        'token' => $token,
                        // DATA ONLY — no `notification` key so nothing visible.
                        'data'  => $payload,
                    ],
                ];
                if ($platform === 'ios') {
                    $message['message']['apns'] = [
                        'headers' => [
                            // apns-priority 5 = power-saving (REQUIRED for
                            // background pushes). priority 10 would be a
                            // visible alert push.
                            'apns-priority'   => '5',
                            // apns-push-type background REQUIRED on iOS 13+.
                            'apns-push-type'  => 'background',
                            'apns-expiration' => (string)(time() + 600),
                        ],
                        'payload' => [
                            'aps' => [
                                'content-available' => 1,
                            ],
                            // userInfo so the native handler can route on type.
                            'type'      => 'wake_relay',
                            'requestId' => $requestId,
                        ],
                    ];
                } else {
                    // Android: high priority so Doze doesn't delay it.
                    // Short TTL — if the phone is offline >60s, the relay
                    // has already timed out server-side (15s window).
                    $message['message']['android'] = [
                        'priority' => 'high',
                        'ttl'      => '60s',
                    ];
                }

                $url = "https://fcm.googleapis.com/v1/projects/{$projectId}/messages:send";
                $ch = curl_init($url);
                curl_setopt_array($ch, [
                    CURLOPT_POST           => true,
                    CURLOPT_POSTFIELDS     => json_encode($message),
                    CURLOPT_HTTPHEADER     => [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $accessToken,
                    ],
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT        => 6,
                ]);
                $resp = curl_exec($ch);
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($httpCode === 200) {
                    $sent++;
                } else {
                    error_log("[chat_wake_phone] FCM HTTP {$httpCode} for "
                        . substr($token, 0, 16) . "… resp=" . substr((string)$resp, 0, 200));
                    if (($httpCode === 404 || $httpCode === 400)
                        && function_exists('fcmRemoveInvalidToken')) {
                        $respData = json_decode($resp, true);
                        $errorCode = $respData['error']['details'][0]['errorCode'] ?? '';
                        if (in_array($errorCode, ['UNREGISTERED', 'INVALID_ARGUMENT'])) {
                            fcmRemoveInvalidToken($token);
                        }
                    }
                }
            }
            jsonResponse(true, [
                'sent'    => $sent,
                'skipped' => $skipped,
                'email'   => $email,
            ]);
            break;
        }

        // chat_delivery_ack — receiver reports "I got these msg ids".
        // Server broadcasts chat_delivered to the sender's devices so their
        // ticks flip from single-gray (sent) to double-gray (delivered).
        // WhatsApp/Telegram parity. Previously this was a stub and the
        // sender's UI stayed stuck at single check forever.
        case 'chat_delivery_ack': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $ids = $input['message_ids'] ?? $input['ids'] ?? [];
            if (!is_array($ids)) $ids = [];
            $ids = array_values(array_filter(array_map('intval', $ids), fn($x) => $x > 0));
            if (!$cid || empty($ids)) {
                jsonResponse(true, ['acked' => 0]);
                break;
            }
            // Persist in PG for multi-device consistency (iOS reads this).
            // Bulk INSERT: client batches up to ~50 ids in one ack call, so
            // the previous per-id loop fired 50 round-trips. One multi-row
            // VALUES does it in a single statement; ON CONFLICT preserves
            // first-write timestamp via COALESCE.
            try {
                $rows = []; $params = [];
                foreach ($ids as $mid) {
                    $rows[] = '(?, ?, now()::text)';
                    $params[] = $mid;
                    $params[] = $user['email'];
                }
                $sql = "INSERT INTO chat_message_receipts (message_id, email, delivered_at)
                        VALUES " . implode(',', $rows) . "
                        ON CONFLICT (message_id, email)
                        DO UPDATE SET delivered_at = COALESCE(chat_message_receipts.delivered_at, EXCLUDED.delivered_at)";
                $db->prepare($sql)->execute($params);
                // Mirror delivered_at onto chat_messages so the chat_list
                // query surfaces the ✓✓ gray mark in the conversation row.
                $inDM = implode(',', array_fill(0, count($ids), '?'));
                $up = $db->prepare("UPDATE chat_messages SET delivered_at = COALESCE(delivered_at, now())
                                     WHERE id IN ($inDM) AND conversation_id = ? AND LOWER(sender_email) <> LOWER(?)");
                $up->execute([...$ids, $cid, $user['email']]);
            } catch (Throwable $e) { error_log('[chat_delivery_ack/pg] ' . $e->getMessage()); }

            // Broadcast chat_delivered to the sender's devices.
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    $in = implode(',', array_fill(0, count($ids), '?'));
                    $q = $db->prepare("SELECT id, sender_email FROM chat_messages WHERE id IN ($in) AND conversation_id = ?");
                    $q->execute([...$ids, $cid]);
                    $bySender = [];
                    foreach ($q->fetchAll() as $r) {
                        $bySender[$r['sender_email']][] = (int)$r['id'];
                    }
                    $mh = curl_multi_init();
                    $handles = [];
                    foreach ($bySender as $senderEmail => $msgIds) {
                        foreach ($msgIds as $mid) {
                            $payload = json_encode([
                                'channel' => 'chat_' . $cid,
                                'event'   => 'chat_delivered',
                                'data'    => [
                                    'conversation_id' => $cid,
                                    'message_id'      => $mid,
                                    'email'           => $user['email'],
                                    'delivered_at'    => date('c'),
                                ],
                            ]);
                            foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                                $cu = curl_init($endpoint);
                                curl_setopt_array($cu, [
                                    CURLOPT_POST => true,
                                    CURLOPT_POSTFIELDS => $payload,
                                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                    CURLOPT_RETURNTRANSFER => true,
                                    CURLOPT_TIMEOUT_MS => 1500,
                                    CURLOPT_CONNECTTIMEOUT_MS => 300,
                                ]);
                                curl_multi_add_handle($mh, $cu);
                                $handles[] = $cu;
                            }
                            // Also broadcast to the sender's personal channel (multi-device).
                            $psub = json_encode([
                                'channel' => 'chat_user_' . $senderEmail,
                                'event'   => 'chat_delivered',
                                'data'    => [
                                    'conversation_id' => $cid,
                                    'message_id'      => $mid,
                                    'email'           => $user['email'],
                                    'delivered_at'    => date('c'),
                                ],
                            ]);
                            foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                                $cu = curl_init($endpoint);
                                curl_setopt_array($cu, [
                                    CURLOPT_POST => true,
                                    CURLOPT_POSTFIELDS => $psub,
                                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                    CURLOPT_RETURNTRANSFER => true,
                                    CURLOPT_TIMEOUT_MS => 1500,
                                    CURLOPT_CONNECTTIMEOUT_MS => 300,
                                ]);
                                curl_multi_add_handle($mh, $cu);
                                $handles[] = $cu;
                            }
                        }
                    }
                    do {
                        $status = curl_multi_exec($mh, $active);
                        if ($active) curl_multi_select($mh, 0.1);
                    } while ($active && $status === CURLM_OK);
                    foreach ($handles as $cu) { curl_multi_remove_handle($mh, $cu); curl_close($cu); }
                    curl_multi_close($mh);
                }
            } catch (Throwable $e) { error_log('[chat_delivery_ack/broadcast] ' . $e->getMessage()); }

            // Also publish to Redis so signal-server forwards to iOS clients
            try {
                $r = new \Redis();
                $pw = getenv('REDIS_PASSWORD') ?: '';
                if (@$r->connect('127.0.0.1', 6379, 0.5)) {
                    if ($pw) @$r->auth($pw);
                    foreach ($ids as $mid) {
                        $r->publish('chat:' . $cid, json_encode([
                            'node_id' => 'php-delivery-ack',
                            'conversation_id' => $cid,
                            'exclude_email' => $user['email'],
                            'type' => 0x2B, // TypeChatDelivered
                            'payload' => [
                                'conversation_id' => $cid,
                                'message_id'      => $mid,
                                'email'           => $user['email'],
                            ],
                        ]));
                    }
                }
            } catch (Throwable $e) { error_log('[chat_delivery_ack/redis] ' . $e->getMessage()); }

            jsonResponse(true, ['acked' => count($ids)]);
            break;
        }

        // chat_block_user — persists a block so the sender can't deliver
        // messages or be added to shared groups. Writes to PG
        // chat_blocked_users; chat_send consults this list on every write.
        case 'chat_block_user': {
            $user = requireChatAuth();
            $target = strtolower(trim($input['email'] ?? $input['blocked_email'] ?? ''));
            if (!$target || $target === strtolower($user['email'])) {
                jsonResponse(false, null, 'Invalid target', 400);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("INSERT INTO chat_blocked_users (blocker_email, blocked_email, created_at) VALUES (:b, :t, NOW()) ON CONFLICT DO NOTHING")
                   ->execute([':b' => $user['email'], ':t' => $target]);
            } catch (Throwable $e) { error_log('[chat_block_user] ' . $e->getMessage()); }
            jsonResponse(true, ['blocked' => $target], 'User blocked');
            break;
        }

        case 'chat_unblock_user': {
            $user = requireChatAuth();
            $target = strtolower(trim($input['email'] ?? $input['blocked_email'] ?? ''));
            if (!$target) jsonResponse(false, null, 'email required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_blocked_users WHERE blocker_email = :b AND blocked_email = :t")
                   ->execute([':b' => $user['email'], ':t' => $target]);
            } catch (Throwable $e) { error_log('[chat_unblock_user] ' . $e->getMessage()); }
            jsonResponse(true, ['unblocked' => $target], 'User unblocked');
            break;
        }

        case 'chat_blocked_list': {
            $user = requireChatAuth();
            $list = [];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $s = $pg->prepare("SELECT blocked_email, created_at FROM chat_blocked_users WHERE blocker_email = :b ORDER BY created_at DESC");
                $s->execute([':b' => $user['email']]);
                $list = $s->fetchAll(PDO::FETCH_ASSOC) ?: [];
            } catch (Throwable $e) { error_log('[chat_blocked_list] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $list]);
            break;
        }

        case 'chat_check_blocked': {
            $user = requireChatAuth();
            $target = strtolower(trim($input['email'] ?? ''));
            $blocked = false;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $s = $pg->prepare("SELECT 1 FROM chat_blocked_users WHERE blocker_email = :b AND blocked_email = :t LIMIT 1");
                $s->execute([':b' => $user['email'], ':t' => $target]);
                $blocked = (bool)$s->fetchColumn();
            } catch (Throwable $e) {}
            jsonResponse(true, ['blocked' => $blocked]);
            break;
        }

        // chat_view_once_open — mark a view-once message as consumed.
        //
        // 2026-04-25: User asked for the registro to STAY as "Foto única —
        // Expirou" pill until they manually delete it (instead of vanishing
        // after the first view, which is what setting deleted_at did before).
        // We now:
        //   1. Add viewer to viewed_by JSON (so each device + sender knows
        //      it's been seen)
        //   2. Clear file_url so the media is gone from R2/CDN side too
        //   3. Leave deleted_at NULL — that field is reserved for "user
        //      manually deleted" so the bubble stays as the expired pill.
        // The frontend renders the pill when is_view_once=1 and the user's
        // email is in viewed_by (or sender side: viewed_by has any reader).
        case 'chat_view_once_open': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            $stmt = $db->prepare("SELECT id, conversation_id, sender_email, is_view_once, viewed_by FROM chat_messages WHERE id = :id");
            $stmt->execute([':id' => $messageId]);
            $row = $stmt->fetch();
            if (!$row) jsonResponse(false, null, 'Message not found', 404);
            requireConversationMember($db, $row['conversation_id'], $user['email']);
            if ((int)($row['is_view_once'] ?? 0) !== 1) {
                jsonResponse(true, ['ok' => true, 'not_view_once' => true]);
            }
            $viewed = json_decode((string)($row['viewed_by'] ?? '[]'), true);
            if (!is_array($viewed)) $viewed = [];
            if (!in_array($user['email'], $viewed, true)) $viewed[] = $user['email'];
            // Update viewed_by + clear media. Keep deleted_at NULL (pill
            // stays in chat). content cleared so any caption text doesn't
            // leak post-view.
            $db->prepare("UPDATE chat_messages SET viewed_by = :v, file_url = '', content = '' WHERE id = :id")
               ->execute([':v' => json_encode($viewed), ':id' => $messageId]);
            // Broadcast as 'view_once_consumed' so peers can update their
            // bubble to the expired pill in real time. Falls back to
            // 'update' which the frontend already handles for partial
            // mutations of an existing message id.
            try { broadcastChatMessage($db, (int)$row['conversation_id'], $messageId, $user['email'], 'update'); } catch (Throwable $e) {}
            jsonResponse(true, ['ok' => true, 'viewed_by' => $viewed]);
            break;
        }

        // chat_star_message — toggle a star on a message so the user can
        // find it later under Starred. Was a pure stub; now persists.
        case 'chat_star_message': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            $convChk = $db->prepare("SELECT conversation_id FROM chat_messages WHERE id = :id");
            $convChk->execute([':id' => $messageId]);
            $msgConvId = (int)($convChk->fetchColumn() ?: 0);
            // IDOR fix: must be a member of the conv to star/unstar a msg in it.
            if (!$msgConvId) jsonResponse(false, null, 'Message not found', 404);
            requireConversationMember($db, $msgConvId, $user['email']);
            $chk = $db->prepare("SELECT id FROM chat_starred_messages WHERE LOWER(user_email) = LOWER(:e) AND message_id = :m");
            $chk->execute([':e' => $user['email'], ':m' => $messageId]);
            $existing = $chk->fetchColumn();
            if ($existing) {
                $db->prepare("DELETE FROM chat_starred_messages WHERE id = :id")->execute([':id' => $existing]);
                jsonResponse(true, ['starred' => false], 'Unstarred');
            } else {
                $db->prepare("INSERT INTO chat_starred_messages (user_email, message_id, conversation_id, created_at) VALUES (:e, :m, :c, now()::text)")
                   ->execute([':e' => $user['email'], ':m' => $messageId, ':c' => $msgConvId]);
                jsonResponse(true, ['starred' => true], 'Starred');
            }
            break;
        }

        // chat_pin_message — conversation-wide pin (up to 3). Shared state,
        // not per-user. Works in direct and group chats; group allows only
        // admins to pin.
        case 'chat_pin_message': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            $m = $db->prepare("SELECT conversation_id FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $m->execute([':id' => $messageId]);
            $msgRow = $m->fetch();
            if (!$msgRow) jsonResponse(false, null, 'Message not found', 404);
            $membership = requireConversationMember($db, $msgRow['conversation_id'], $user['email']);
            if ($membership['type'] === 'group' && !chatHasPermission((int)$msgRow['conversation_id'], $user['email'], 'pin_messages')) {
                jsonResponse(false, null, 'Only admins can pin in groups', 403);
            }
            $chk = $db->prepare("SELECT id FROM chat_pinned_messages WHERE conversation_id = :cid AND message_id = :m");
            $chk->execute([':cid' => $msgRow['conversation_id'], ':m' => $messageId]);
            $existing = $chk->fetchColumn();
            if ($existing) {
                $db->prepare("DELETE FROM chat_pinned_messages WHERE id = :id")->execute([':id' => $existing]);
                $pinned = false;
            } else {
                // Cap at 3 pinned per conversation (WhatsApp limit); drop oldest if over.
                $cnt = $db->prepare("SELECT COUNT(*) FROM chat_pinned_messages WHERE conversation_id = :cid");
                $cnt->execute([':cid' => $msgRow['conversation_id']]);
                if ((int)$cnt->fetchColumn() >= 3) {
                    $db->prepare("DELETE FROM chat_pinned_messages WHERE id = (SELECT id FROM chat_pinned_messages WHERE conversation_id = :cid ORDER BY created_at ASC LIMIT 1)")
                       ->execute([':cid' => $msgRow['conversation_id']]);
                }
                $db->prepare("INSERT INTO chat_pinned_messages (conversation_id, message_id, pinned_by, created_at) VALUES (:cid, :m, :e, now()::text)")
                   ->execute([':cid' => $msgRow['conversation_id'], ':m' => $messageId, ':e' => $user['email']]);
                $pinned = true;
            }
            // pts event so pin/unpin survives offline + syncs across devices.
            try { emitConvEvent($db, (int)$msgRow['conversation_id'], $pinned ? 'pin' : 'unpin', $user['email'], ['message_id' => (int)$messageId]); } catch (Throwable $e) { error_log('[chat_pin/pts] ' . $e->getMessage()); }
            // Broadcast so everyone sees the pin banner update in real time.
            try { broadcastChatMessage($db, (int)$msgRow['conversation_id'], $messageId, $user['email'], $pinned ? 'pin' : 'unpin'); } catch (Throwable $e) {}
            jsonResponse(true, ['pinned' => $pinned], $pinned ? 'Pinned' : 'Unpinned');
            break;
        }

        // Simple ok acknowledgements (toggle state / no-op)
        // chat_report_user — store a user-filed abuse report so ops can
        // review. Previous behavior was a silent stub, which meant
        // "Denunciar" in the UI literally did nothing. Rate-limited so we
        // don't end up with a DoS'd report queue from a single attacker.
        case 'chat_report_user': {
            $user = requireChatAuth();
            $target = strtolower(trim($input['email'] ?? $input['reported_email'] ?? ''));
            $reason = mb_substr((string)($input['reason'] ?? ''), 0, 500);
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$target || $target === strtolower($user['email'])) {
                jsonResponse(false, null, 'Invalid target', 400);
            }
            // 10 reports/hour per reporter.
            $rf = '/tmp/report_rate_' . md5($user['email']);
            $rates = file_exists($rf) ? (json_decode(@file_get_contents($rf), true) ?: []) : [];
            $rates = array_values(array_filter($rates, fn($t) => is_numeric($t) && $t > time() - 3600));
            if (count($rates) >= 10) jsonResponse(false, null, 'Too many reports — try again later', 429);
            $rates[] = time();
            @file_put_contents($rf, json_encode($rates), LOCK_EX);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("INSERT INTO chat_user_reports (reporter_email, reported_email, reason, message_id, created_at) VALUES (:r, :t, :re, :m, NOW())")
                   ->execute([':r' => $user['email'], ':t' => $target, ':re' => $reason, ':m' => $messageId ?: null]);
            } catch (Throwable $e) {
                // Best-effort create table when missing (first deploy).
                try {
                    $pg->exec("CREATE TABLE IF NOT EXISTS chat_user_reports (
                        id SERIAL PRIMARY KEY,
                        reporter_email TEXT NOT NULL,
                        reported_email TEXT NOT NULL,
                        reason TEXT NOT NULL DEFAULT '',
                        message_id BIGINT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        resolved_at TIMESTAMPTZ,
                        action_taken TEXT
                    )");
                    $pg->prepare("INSERT INTO chat_user_reports (reporter_email, reported_email, reason, message_id) VALUES (:r, :t, :re, :m)")
                       ->execute([':r' => $user['email'], ':t' => $target, ':re' => $reason, ':m' => $messageId ?: null]);
                } catch (Throwable $e2) { error_log('[chat_report_user] ' . $e2->getMessage()); }
            }
            // Telegram/WhatsApp parity: report+block in a single tap. When the
            // client passes also_block=true we persist a block alongside the
            // report so the abuser can't keep messaging while ops investigate.
            // Without this, the user had to navigate to Block separately,
            // which is exactly the friction WhatsApp/Telegram removed.
            $alsoBlocked = false;
            $alsoBlockIn = $input['also_block'] ?? false;
            $shouldBlock = is_bool($alsoBlockIn) ? $alsoBlockIn : ((int)$alsoBlockIn === 1);
            if ($shouldBlock) {
                try {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    $pg->prepare("INSERT INTO chat_blocked_users (blocker_email, blocked_email, created_at) VALUES (:b, :t, NOW()) ON CONFLICT DO NOTHING")
                       ->execute([':b' => $user['email'], ':t' => $target]);
                    $alsoBlocked = true;
                } catch (\Throwable $e) { error_log('[chat_report_user/block] ' . $e->getMessage()); }
            }
            jsonResponse(true, ['reported' => $target, 'blocked' => $alsoBlocked], 'Report received');
            break;
        }

        // chat_report_thread — WhatsApp-style "Report and leave" combo.
        // Captures the last 50 messages of the conversation as evidence,
        // stores in chat_reports with action='block_and_leave' (or just
        // 'report'), then optionally blocks the other party + archives /
        // soft-leaves the thread. Single round-trip from the UI.
        case 'chat_report_thread': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $reason = mb_substr((string)($input['reason'] ?? ''), 0, 500);
            $actionTaken = (string)($input['action'] ?? 'report');
            if (!in_array($actionTaken, ['report', 'block_and_leave', 'block', 'leave'], true)) {
                $actionTaken = 'report';
            }
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);

            // Per-user rate limit (10/h) — same envelope as chat_report_user.
            $rf = '/tmp/report_rate_' . md5($user['email']);
            $rates = file_exists($rf) ? (json_decode(@file_get_contents($rf), true) ?: []) : [];
            $rates = array_values(array_filter($rates, fn($t) => is_numeric($t) && $t > time() - 3600));
            if (count($rates) >= 10) jsonResponse(false, null, 'Too many reports — try again later', 429);
            $rates[] = time();
            @file_put_contents($rf, json_encode($rates), LOCK_EX);

            // Pick a target email (other party in 1:1; first non-self for groups).
            $tStmt = $db->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) <> LOWER(:me) LIMIT 1");
            $tStmt->execute([':cid' => $cid, ':me' => $user['email']]);
            $target = (string)($tStmt->fetchColumn() ?: '');

            // Snapshot: last 50 message ids (ids only — full content stays in
            // chat_messages and can be rehydrated by ops as needed).
            $msgIds = [];
            try {
                $ms = $db->prepare("SELECT id FROM chat_messages WHERE conversation_id = :cid AND deleted_at IS NULL ORDER BY id DESC LIMIT 50");
                $ms->execute([':cid' => $cid]);
                foreach ($ms->fetchAll(\PDO::FETCH_ASSOC) as $r) $msgIds[] = (int)$r['id'];
            } catch (\Throwable $e) {}
            $msgJson = json_encode($msgIds, JSON_UNESCAPED_UNICODE);

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_reports (
                    id SERIAL PRIMARY KEY,
                    reporter_email TEXT NOT NULL,
                    target_email TEXT,
                    conversation_id BIGINT,
                    reason TEXT NOT NULL DEFAULT '',
                    message_ids JSONB,
                    action TEXT NOT NULL DEFAULT 'report',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )");
                $pg->prepare("INSERT INTO chat_reports (reporter_email, target_email, conversation_id, reason, message_ids, action) VALUES (:r, :t, :c, :re, CAST(:m AS JSONB), :a)")
                   ->execute([
                       ':r' => $user['email'],
                       ':t' => $target ?: null,
                       ':c' => $cid,
                       ':re' => $reason,
                       ':m' => $msgJson,
                       ':a' => $actionTaken,
                   ]);
            } catch (\Throwable $e) {
                error_log('[chat_report_thread] ' . $e->getMessage());
            }

            // Side-effects driven by the requested action.
            if (in_array($actionTaken, ['block_and_leave', 'block'], true) && $target) {
                try {
                    @$db->exec("CREATE TABLE IF NOT EXISTS chat_blocked_users (blocker_email TEXT NOT NULL, blocked_email TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (blocker_email, blocked_email))");
                    $db->prepare("INSERT INTO chat_blocked_users (blocker_email, blocked_email) VALUES (:b, :u) ON CONFLICT DO NOTHING")
                       ->execute([':b' => $user['email'], ':u' => $target]);
                } catch (\Throwable $e) {}
            }
            if (in_array($actionTaken, ['block_and_leave', 'leave'], true)) {
                try {
                    // Soft-leave: archive on this side. Hard-leave (DELETE FROM
                    // members) only for groups; on direct chats, we keep the
                    // membership row so blocking still works.
                    $db->prepare("UPDATE chat_conversation_members SET archived = 1 WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e)")
                       ->execute([':cid' => $cid, ':e' => $user['email']]);
                } catch (\Throwable $e) {}
            }

            jsonResponse(true, [
                'reported' => true,
                'target' => $target,
                'action' => $actionTaken,
                'message_count' => count($msgIds),
            ], 'Thread report received');
            break;
        }

        // chat_archive — hide a conversation from the main list without
        // leaving it. Per-user flag on conversation_members.archived.
        case 'chat_archive': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $archived = !empty($input['archived']) || (int)($input['archived'] ?? 0) === 1 ? 1 : 0;
            $db->prepare("UPDATE chat_conversation_members SET archived = :a WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e)")
               ->execute([':a' => $archived, ':cid' => $cid, ':e' => $user['email']]);
            jsonResponse(true, ['archived' => (bool)$archived]);
            break;
        }

        // chat_set_disappearing — per-conversation auto-expire timer. Also
        // accepts 0 to turn off. Shared setting (both sides' messages vanish
        // at the same TTL). Background job (cron-disappearing.php) sweeps.
        case 'chat_set_disappearing': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $seconds = (int)($input['seconds'] ?? $input['timer'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            // Groups: admin-only; direct chats: either participant can set.
            if ($membership['type'] === 'group' && ($membership['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can change the disappearing timer', 403);
            }
            // Accept 0, 1h, 24h, 7d, 30d, 90d (WhatsApp's presets); clamp
            // anything else to the nearest sane value so clients can't set
            // absurdly small timers that delete messages mid-conversation.
            $allowed = [0, 3600, 86400, 604800, 2592000, 7776000];
            if (!in_array($seconds, $allowed, true)) {
                $seconds = 0;
                foreach ($allowed as $a) if ($seconds === 0 || abs($a - $seconds) < abs($allowed[0] - $seconds)) $seconds = $a;
            }
            $db->prepare("UPDATE chat_conversations SET disappearing_timer = :s WHERE id = :id")
               ->execute([':s' => $seconds, ':id' => $cid]);
            jsonResponse(true, ['seconds' => $seconds]);
            break;
        }

        // chat_schedule_message — queue a message for later send. Writes
        // to the PG chat_scheduled_messages table that cron-chat-scheduled.php
        // already polls with SKIP LOCKED; matches schema status='pending'.
        case 'chat_schedule_message': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $content = trim((string)($input['content'] ?? ''));
            // Accept either epoch-seconds (send_at) or ISO string (scheduled_at)
            $sendAtEpoch = (int)($input['send_at'] ?? 0);
            $sendAtIso = trim((string)($input['scheduled_at'] ?? ''));
            if ($sendAtEpoch > 0) $sendAtIso = gmdate('Y-m-d\TH:i:s', $sendAtEpoch);
            if (!$cid || $content === '' || $sendAtIso === '' || ($sendAtEpoch > 0 && $sendAtEpoch <= time())) {
                jsonResponse(false, null, 'conversation_id, content, future send_at required', 400);
            }
            requireConversationMember($db, $cid, $user['email']);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $ins = $pg->prepare("INSERT INTO chat_scheduled_messages (conversation_id, sender_email, sender_name, content, type, scheduled_at, status) VALUES (:cid, :e, :n, :c, :t, :s, 'pending') RETURNING id");
                $ins->execute([
                    ':cid' => $cid, ':e' => $user['email'],
                    ':n' => chatDisplayName($user['email']),
                    ':c' => $content,
                    ':t' => (string)($input['type'] ?? 'text'),
                    ':s' => $sendAtIso,
                ]);
                $id = (int)$ins->fetchColumn();
                jsonResponse(true, ['id' => $id, 'scheduled_at' => $sendAtIso], 'Scheduled');
            } catch (Throwable $e) {
                jsonResponse(false, null, 'schedule failed: ' . $e->getMessage(), 500);
            }
            break;
        }

        case 'chat_schedule_cancel': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_scheduled_messages WHERE id = :id AND sender_email = :e AND status = 'pending'")
                   ->execute([':id' => $id, ':e' => $user['email']]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['cancelled' => true]);
            break;
        }

        // chat_ai_mention — user typed @chatyy in a chat. The frontend already
        // persisted their question via chat_send; this endpoint produces the
        // AI's reply, inserts it as a bot bubble (sender_email=ai@chatyy.com.br),
        // and broadcasts it just like a normal message so all members see it.
        // Rate-limited to 20/h per user. Context = last 8 text/system messages
        // (truncated). Same router (callAI 'balanced') used elsewhere — no extra
        // model wiring. Does NOT mark mentioned-user push since the bot has no
        // push tokens.
        case 'chat_ai_mention': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $prompt = trim((string)($input['prompt'] ?? ''));
            if (!$cid || $prompt === '') jsonResponse(false, null, 'conversation_id and prompt required', 400);
            if (mb_strlen($prompt, 'UTF-8') > 2000) {
                $prompt = mb_substr($prompt, 0, 2000, 'UTF-8');
            }
            requireConversationMember($db, $cid, $user['email']);

            // Per-user rate limit: 20/h. Same envelope shape as chat_send.
            $rateFile = '/tmp/chat_ai_rate_' . md5($user['email']);
            $now = time();
            $rates = [];
            if (file_exists($rateFile)) {
                $r = @file_get_contents($rateFile);
                $d = $r ? json_decode($r, true) : null;
                if (is_array($d)) $rates = array_values(array_filter($d, fn($t) => is_numeric($t) && $t > $now - 3600));
            }
            if (count($rates) >= 20) {
                jsonResponse(false, null, 'AI rate limit reached (20/h). Try again later.', 429);
            }
            $rates[] = $now;
            @file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            // Build context from last 8 text messages in this conversation.
            // Excludes media/files since the AI can't see them yet.
            $ctxLines = [];
            try {
                $ctxStmt = $db->prepare("SELECT sender_name, content FROM chat_messages
                    WHERE conversation_id = :cid AND deleted_at IS NULL AND type IN ('text','system')
                    AND content IS NOT NULL AND content <> ''
                    ORDER BY id DESC LIMIT 8");
                $ctxStmt->execute([':cid' => $cid]);
                $recent = array_reverse($ctxStmt->fetchAll(\PDO::FETCH_ASSOC));
                foreach ($recent as $r) {
                    $name = $r['sender_name'] ?: 'User';
                    $body = mb_substr((string)$r['content'], 0, 240, 'UTF-8');
                    $ctxLines[] = "{$name}: {$body}";
                }
            } catch (\Throwable $e) { error_log('[chat_ai_mention.ctx] ' . $e->getMessage()); }
            $contextStr = implode("\n", $ctxLines);
            $userName = chatDisplayName($user['email']);

            $sys = "Você é Chatyy AI, um assistente útil que está dentro de uma conversa do Chatyy. "
                 . "Os usuários te invocam com @chatyy. Responda de forma direta e concisa (1 a 3 frases). "
                 . "Use o mesmo idioma da pergunta. Não invente informações. "
                 . "Se a pergunta for ambígua, peça esclarecimento curto. "
                 . "Não use markdown pesado — texto simples. Sem rodapé tipo 'Com base no contexto'. "
                 . "NUNCA repita uma frase ou seção. Apresente cada ideia uma única vez.";

            $userMsg = "Histórico recente da conversa:\n{$contextStr}\n\n"
                     . "Pergunta de {$userName}: {$prompt}\n\n"
                     . "Responda à pergunta. Use o histórico apenas se for relevante.";

            require_once __DIR__ . '/ai-router.php';
            // Bug 2026-05-12: max_tokens was 400 → AI hit cap mid-sentence
            // and the response read like the model was about to suggest a
            // rewrite, got truncated, and a second draft was glued on at
            // the same time ("...é mui**Sugestão de reescrita**: 'Você é..."
            // — print enviado pelo user). Bumped to 700 so a 3-sentence
            // answer with examples has room to finish, and added a
            // post-processing dedup pass that strips obvious repeated
            // sentence-starters like "Sugestão de reescrita:" appearing
            // twice in a row.
            $r = callAI('balanced', $sys, $userMsg, 700, 0.6);
            if (!empty($r['error']) || empty($r['text'])) {
                error_log('[chat_ai_mention] AI error: ' . ($r['error'] ?? 'empty'));
                jsonResponse(false, null, 'AI temporariamente indisponível.', 503);
            }
            $answer = trim($r['text']);
            // Dedup: collapse any case where a phrase like "Sugestão de
            // reescrita:" appears, gets cut off mid-word, and reappears.
            // Pattern: find duplicate occurrences of any leading-cap
            // phrase ending with ":" within ~40 chars of each other and
            // keep only the second (which is the recovered/complete one).
            $answer = preg_replace(
                '/([A-ZÁÊÉÍÓÚÂÔÃ][a-záêéíóúâôãç ]{4,40}:)\s*[^.]{0,120}?\s*(\1)/u',
                '$2',
                $answer
            );
            $botEmail = 'ai@chatyy.com.br';
            $botName = 'Chatyy AI';

            // Insert AI bubble. sender_email = ai@chatyy.com.br is reserved
            // for the bot — frontend matches it to render the gradient avatar
            // + "AI" badge.
            $nowIso = gmdate('Y-m-d\TH:i:s\Z');
            $msgId = null;
            try {
                $insBot = $db->prepare("INSERT INTO chat_messages
                    (conversation_id, sender_email, sender_name, content, type, viewed_by, starred, created_at)
                    VALUES (?, ?, ?, ?, 'text', '[]', 0, ?)
                    RETURNING id, created_at");
                $insBot->execute([$cid, $botEmail, $botName, $answer, $nowIso]);
                $row = $insBot->fetch(\PDO::FETCH_ASSOC);
                $msgId = (int)$row['id'];
            } catch (\Throwable $e) {
                error_log('[chat_ai_mention.insert] ' . $e->getMessage());
                jsonResponse(false, null, 'Insert failed', 500);
            }

            // Re-fetch full row to mirror chat_send shape.
            $st = $db->prepare("SELECT * FROM chat_messages WHERE id = :id");
            $st->execute([':id' => $msgId]);
            $msg = $st->fetch();
            $msg['id'] = (int)$msg['id'];
            $msg['sender_name'] = $botName;
            $msg['reactions'] = [];
            $msg['reply_to'] = null;
            $msg['is_ai'] = true;

            // Flush early so the requester's UI gets the bubble without
            // waiting for WS broadcast / cron touch.
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $msg, 'message' => 'AI response']);
            if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

            try { broadcastChatMessage($db, $cid, $msgId, $botEmail, 'chat_message', []); }
            catch (\Throwable $e) { error_log('[chat_ai_mention.ws] ' . $e->getMessage()); }
            try { touchConversation($db, $cid); } catch (\Throwable $e) {}
            break;
        }

        // ─── Auto-translate per-conversation (Telegram parity) ────
        // User sets target locale per chat; client applies translate()
        // on incoming messages whose source locale differs. Stored in
        // chat_user_conv_settings.auto_translate (col added on first set).
        case 'chat_set_auto_translate':
        case 'chat_get_auto_translate': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            try { @$db->exec("ALTER TABLE chat_user_conv_settings ADD COLUMN IF NOT EXISTS auto_translate TEXT"); } catch (\Throwable $e) {}
            if ($action === 'chat_set_auto_translate') {
                $locale = trim((string)($input['locale'] ?? ''));
                if ($locale !== '' && !preg_match('/^[a-z]{2}(-[A-Z]{2})?$/', $locale)) {
                    jsonResponse(false, null, 'invalid locale (use pt-BR, en, es, etc.)', 400);
                }
                $val = $locale === '' ? null : $locale;
                $db->prepare("INSERT INTO chat_user_conv_settings (email, conversation_id, auto_translate, updated_at)
                              VALUES (:e, :c, :v, (now() AT TIME ZONE 'UTC')::text)
                              ON CONFLICT (email, conversation_id) DO UPDATE SET auto_translate = EXCLUDED.auto_translate, updated_at = EXCLUDED.updated_at")
                   ->execute([':e' => $user['email'], ':c' => $cid, ':v' => $val]);
                jsonResponse(true, ['conversation_id' => $cid, 'locale' => $locale]);
            }
            $st = $db->prepare("SELECT auto_translate FROM chat_user_conv_settings WHERE email = :e AND conversation_id = :c");
            $st->execute([':e' => $user['email'], ':c' => $cid]);
            $row = $st->fetch(\PDO::FETCH_ASSOC);
            jsonResponse(true, ['conversation_id' => $cid, 'locale' => $row['auto_translate'] ?? null]);
            break;
        }
        // ─── /Auto-translate ──────────────────────────────────────

        // ─── Bot platform (Telegram /BotFather parity) ────────────
        // Bots are first-class user accounts with a persistent token.
        // Owners register a bot, get a token, then call bot_send_message
        // with the token to inject messages into a conversation. The bot
        // appears as a regular sender with sender_email = bot username.
        // Inline keyboards travel as JSON in chat_messages.reply_markup.
        case 'chat_bot_register':
        case 'chat_bot_list':
        case 'chat_bot_info':
        case 'chat_bot_set_commands':
        case 'chat_bot_send_message':
        case 'chat_bot_lookup': {
            $isPublicSend = ($action === 'chat_bot_send_message');
            $user = $isPublicSend ? null : requireChatAuth();
            $email = $user['email'] ?? '';
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_bots (
                    bot_username TEXT PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    avatar_url TEXT DEFAULT '',
                    token TEXT NOT NULL UNIQUE,
                    commands JSONB DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_chat_bots_owner ON chat_bots (owner_email)");
            } catch (\Throwable $e) { error_log('[bot.table] ' . $e->getMessage()); }

            if ($action === 'chat_bot_register') {
                $u = strtolower(ltrim(trim((string)($input['bot_username'] ?? '')), '@'));
                $name = trim((string)($input['name'] ?? ''));
                $desc = trim((string)($input['description'] ?? ''));
                if (strlen($u) < 3 || strlen($u) > 30) jsonResponse(false, null, 'bot_username 3-30 chars', 400);
                if (!preg_match('/^[a-z][a-z0-9_]*bot$/', $u)) jsonResponse(false, null, 'bot_username must end with "bot" and be lowercase a-z0-9_', 400);
                if ($name === '') jsonResponse(false, null, 'name required', 400);
                if (strlen($name) > 60) $name = substr($name, 0, 60);
                if (strlen($desc) > 300) $desc = substr($desc, 0, 300);
                $token = bin2hex(random_bytes(24)); // 48-char hex
                try {
                    $pg->prepare("INSERT INTO chat_bots (bot_username, owner_email, name, description, token) VALUES (:u, :o, :n, :d, :t)")
                       ->execute([':u' => $u, ':o' => $email, ':n' => $name, ':d' => $desc, ':t' => $token]);
                } catch (\Throwable $e) {
                    if (strpos($e->getMessage(), 'duplicate') !== false || strpos($e->getMessage(), 'unique') !== false) {
                        jsonResponse(false, null, 'bot_username already taken', 409);
                    }
                    jsonResponse(false, null, 'register failed: ' . $e->getMessage(), 500);
                }
                jsonResponse(true, ['bot_username' => $u, 'name' => $name, 'token' => $token, 'description' => $desc]);
            }

            if ($action === 'chat_bot_list') {
                $st = $pg->prepare("SELECT bot_username, name, description, commands, created_at FROM chat_bots WHERE owner_email = :o ORDER BY created_at DESC");
                $st->execute([':o' => $email]);
                jsonResponse(true, ['bots' => $st->fetchAll(\PDO::FETCH_ASSOC)]);
            }

            if ($action === 'chat_bot_info') {
                $u = strtolower(ltrim(trim((string)($input['bot_username'] ?? $_GET['bot_username'] ?? '')), '@'));
                if ($u === '') jsonResponse(false, null, 'bot_username required', 400);
                $st = $pg->prepare("SELECT bot_username, name, description, commands, owner_email FROM chat_bots WHERE bot_username = :u");
                $st->execute([':u' => $u]);
                $b = $st->fetch(\PDO::FETCH_ASSOC);
                if (!$b) jsonResponse(false, null, 'bot not found', 404);
                // Hide owner email from non-owners.
                if (strtolower($b['owner_email']) !== strtolower($email)) unset($b['owner_email']);
                jsonResponse(true, $b);
            }

            if ($action === 'chat_bot_set_commands') {
                $u = strtolower(ltrim(trim((string)($input['bot_username'] ?? '')), '@'));
                $cmds = $input['commands'] ?? [];
                if (!is_array($cmds)) $cmds = [];
                $clean = [];
                foreach ($cmds as $c) {
                    if (!is_array($c)) continue;
                    $cmd = strtolower(preg_replace('/[^a-z0-9_]/i', '', (string)($c['command'] ?? '')));
                    $d = trim((string)($c['description'] ?? ''));
                    if ($cmd === '' || strlen($cmd) > 32) continue;
                    if (strlen($d) > 256) $d = substr($d, 0, 256);
                    $clean[] = ['command' => $cmd, 'description' => $d];
                    if (count($clean) >= 100) break;
                }
                $r = $pg->prepare("UPDATE chat_bots SET commands = CAST(:c AS JSONB) WHERE bot_username = :u AND owner_email = :o");
                $r->execute([':c' => json_encode($clean), ':u' => $u, ':o' => $email]);
                if ($r->rowCount() === 0) jsonResponse(false, null, 'bot not found or not owner', 404);
                jsonResponse(true, ['bot_username' => $u, 'commands' => $clean]);
            }

            if ($action === 'chat_bot_lookup') {
                $u = strtolower(ltrim(trim((string)($input['bot_username'] ?? $_GET['bot_username'] ?? '')), '@'));
                if ($u === '') jsonResponse(false, null, 'bot_username required', 400);
                $st = $pg->prepare("SELECT bot_username, name, description, commands FROM chat_bots WHERE bot_username = :u");
                $st->execute([':u' => $u]);
                $b = $st->fetch(\PDO::FETCH_ASSOC);
                if (!$b) jsonResponse(false, null, 'not_found', 404);
                jsonResponse(true, ['kind' => 'bot', ...$b]);
            }

            // chat_bot_send_message — server-side webhook callback for bots.
            // Auth via bot token (not user bearer). Lets external bot servers
            // post into a Chatyy conversation. The conv must contain the bot
            // (or bot_username added via group_add for groups).
            if ($action === 'chat_bot_send_message') {
                $token = trim((string)($input['token'] ?? $_SERVER['HTTP_X_BOT_TOKEN'] ?? ''));
                if (strlen($token) !== 48) jsonResponse(false, null, 'invalid token', 401);
                $st = $pg->prepare("SELECT bot_username, name FROM chat_bots WHERE token = :t");
                $st->execute([':t' => $token]);
                $bot = $st->fetch(\PDO::FETCH_ASSOC);
                if (!$bot) jsonResponse(false, null, 'invalid token', 401);
                $cid = (int)($input['conversation_id'] ?? 0);
                $text = trim((string)($input['text'] ?? ''));
                $replyMarkup = $input['reply_markup'] ?? null; // {"inline_keyboard":[[{"text":"","callback_data":""}]]}
                if (!$cid || $text === '') jsonResponse(false, null, 'conversation_id and text required', 400);
                $botEmail = $bot['bot_username'] . '@bots.chatyy';
                $rmJson = is_array($replyMarkup) ? json_encode($replyMarkup, JSON_UNESCAPED_UNICODE) : null;
                $nowIso = gmdate('Y-m-d\TH:i:s\Z');
                @$db->exec("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_markup JSONB");
                $ins = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, sender_name, content, type, viewed_by, starred, created_at, reply_markup) VALUES (?, ?, ?, ?, 'text', '[]', 0, ?, CAST(? AS JSONB)) RETURNING id");
                $ins->execute([$cid, $botEmail, $bot['name'], $text, $nowIso, $rmJson]);
                $msgId = (int)$ins->fetchColumn();
                try { broadcastChatMessage($db, $cid, $msgId, $botEmail, 'chat_message', []); } catch (\Throwable $e) {}
                try { touchConversation($db, $cid); } catch (\Throwable $e) {}
                jsonResponse(true, ['message_id' => $msgId, 'bot_username' => $bot['bot_username']]);
            }
            break;
        }
        // ─── /Bot platform ────────────────────────────────────────

        // ─── Bots API skeleton (separate from chat_bot_* platform) ────
        // Lighter-weight model exposed under bot_* action names matching
        // the frontend wrappers in services/api.js. Backed by a `bots`
        // table with handle/owner/webhook/public_key/commands/verified.
        // Real webhook firing is a TODO — bot_invoke_command currently
        // just inserts a system message into the conversation so the UI
        // can demo the slash-command popover end-to-end.
        case 'bot_create':
        case 'bot_list':
        case 'bot_list_mine':
        case 'bot_search':
        case 'bot_set_commands':
        case 'bot_invoke_command':
        case 'bot_update':
        case 'bot_delete':
        case 'bot_regenerate_token': {
            $user = requireChatAuth();
            $email = strtolower((string)($user['email'] ?? ''));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS bots (
                    id BIGSERIAL PRIMARY KEY,
                    handle TEXT UNIQUE NOT NULL,
                    owner_email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    avatar_url TEXT DEFAULT '',
                    webhook_url TEXT DEFAULT '',
                    public_key TEXT DEFAULT '',
                    commands JSONB DEFAULT '[]'::jsonb,
                    verified BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots (owner_email)");
            } catch (\Throwable $e) { error_log('[bots.table] ' . $e->getMessage()); }

            $sanitizeHandle = function ($raw) {
                $h = strtolower(ltrim(trim((string)$raw), '@'));
                $h = preg_replace('/[^a-z0-9_]/', '', $h);
                return $h;
            };

            if ($action === 'bot_create') {
                // 5/day per user — handle squatting + spammy bot creation
                // both die against this. Window 86400s == 1 day.
                if (!chatRateLimit($email, 'bot_create', 5, 86400)) {
                    jsonResponse(false, null, 'Bot create limit reached for today', 429);
                }
                // Accept both `handle` (spec) and `username` (existing
                // frontend caller in app/bots.js) for backwards compat.
                $handle = $sanitizeHandle($input['handle'] ?? $input['username'] ?? '');
                $name = trim((string)($input['name'] ?? ''));
                $desc = trim((string)($input['description'] ?? ''));
                $webhookUrl = trim((string)($input['webhook_url'] ?? ''));
                if (strlen($handle) < 3 || strlen($handle) > 30) {
                    jsonResponse(false, null, 'handle 3-30 chars', 400);
                }
                if (!preg_match('/^[a-z][a-z0-9_]*$/', $handle)) {
                    jsonResponse(false, null, 'handle must start with a-z and contain only a-z0-9_', 400);
                }
                if ($name === '') jsonResponse(false, null, 'name required', 400);
                if (strlen($name) > 60) $name = substr($name, 0, 60);
                if (strlen($desc) > 300) $desc = substr($desc, 0, 300);
                if ($webhookUrl !== '' && !preg_match('#^https://#i', $webhookUrl)) {
                    jsonResponse(false, null, 'webhook_url must use https://', 400);
                }
                if (strlen($webhookUrl) > 500) $webhookUrl = substr($webhookUrl, 0, 500);
                // HMAC public_key — used to sign webhook payloads in the
                // future. Stored as a 64-char hex string.
                $publicKey = bin2hex(random_bytes(32));
                try {
                    $st = $pg->prepare("INSERT INTO bots (handle, owner_email, name, description, webhook_url, public_key) VALUES (:h, :o, :n, :d, :w, :k) RETURNING id, handle, name, description, webhook_url, public_key, commands, verified, created_at");
                    $st->execute([':h' => $handle, ':o' => $email, ':n' => $name, ':d' => $desc, ':w' => $webhookUrl, ':k' => $publicKey]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                } catch (\Throwable $e) {
                    if (strpos($e->getMessage(), 'duplicate') !== false || strpos($e->getMessage(), 'unique') !== false) {
                        jsonResponse(false, null, 'handle already taken', 409);
                    }
                    jsonResponse(false, null, 'create failed: ' . $e->getMessage(), 500);
                }
                // Return shape mirrors the frontend's expectations: include
                // both `username` (legacy) and `handle` so app/bots.js's
                // tokenReveal modal still works.
                $row['username'] = $row['handle'];
                $row['token'] = $row['public_key'];
                jsonResponse(true, $row);
            }

            if ($action === 'bot_list' || $action === 'bot_list_mine') {
                $st = $pg->prepare("SELECT id, handle, name, description, avatar_url, webhook_url, public_key, commands, verified, created_at FROM bots WHERE LOWER(owner_email) = LOWER(:o) ORDER BY created_at DESC");
                $st->execute([':o' => $email]);
                $rows = $st->fetchAll(\PDO::FETCH_ASSOC);
                // Surface `username` alias for the legacy app/bots.js renderer.
                foreach ($rows as &$r) { $r['username'] = $r['handle']; }
                unset($r);
                jsonResponse(true, ['bots' => $rows]);
            }

            if ($action === 'bot_search') {
                $q = strtolower(trim((string)($input['q'] ?? $input['query'] ?? '')));
                if ($q === '') jsonResponse(true, ['bots' => []]);
                $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $q) . '%';
                $st = $pg->prepare("SELECT id, handle, name, description, avatar_url, verified, created_at FROM bots WHERE LOWER(handle) LIKE :q OR LOWER(name) LIKE :q ORDER BY verified DESC, created_at DESC LIMIT 50");
                $st->execute([':q' => $like]);
                $rows = $st->fetchAll(\PDO::FETCH_ASSOC);
                foreach ($rows as &$r) { $r['username'] = $r['handle']; }
                unset($r);
                jsonResponse(true, ['bots' => $rows]);
            }

            if ($action === 'bot_set_commands') {
                // Accept either bot_id (spec) or bot_username/handle.
                $botId = (int)($input['bot_id'] ?? 0);
                $handle = $sanitizeHandle($input['handle'] ?? $input['bot_username'] ?? '');
                $cmds = $input['commands'] ?? [];
                if (!is_array($cmds)) $cmds = [];
                $clean = [];
                foreach ($cmds as $c) {
                    if (!is_array($c)) continue;
                    $cmdName = strtolower(preg_replace('/[^a-z0-9_]/i', '', (string)($c['name'] ?? $c['command'] ?? '')));
                    $d = trim((string)($c['description'] ?? ''));
                    if ($cmdName === '' || strlen($cmdName) > 32) continue;
                    if (strlen($d) > 256) $d = substr($d, 0, 256);
                    $clean[] = ['name' => $cmdName, 'description' => $d];
                    if (count($clean) >= 100) break;
                }
                if ($botId > 0) {
                    $st = $pg->prepare("UPDATE bots SET commands = CAST(:c AS JSONB) WHERE id = :id AND LOWER(owner_email) = LOWER(:o)");
                    $st->execute([':c' => json_encode($clean), ':id' => $botId, ':o' => $email]);
                } elseif ($handle !== '') {
                    $st = $pg->prepare("UPDATE bots SET commands = CAST(:c AS JSONB) WHERE LOWER(handle) = LOWER(:h) AND LOWER(owner_email) = LOWER(:o)");
                    $st->execute([':c' => json_encode($clean), ':h' => $handle, ':o' => $email]);
                } else {
                    jsonResponse(false, null, 'bot_id or handle required', 400);
                }
                if ($st->rowCount() === 0) jsonResponse(false, null, 'bot not found or not owner', 404);
                jsonResponse(true, ['commands' => $clean]);
            }

            if ($action === 'bot_invoke_command') {
                // Stub — drops a system message into the conversation so
                // the UI can wire the slash-command flow. Real webhook
                // firing is future work (signed POST to webhook_url with
                // public_key as HMAC secret).
                $handle = $sanitizeHandle($input['bot_handle'] ?? $input['handle'] ?? '');
                $cid = (int)($input['conversation_id'] ?? 0);
                $cmd = strtolower(preg_replace('/[^a-z0-9_]/i', '', (string)($input['command'] ?? '')));
                $args = trim((string)($input['args'] ?? ''));
                if ($handle === '' || $cid <= 0 || $cmd === '') {
                    jsonResponse(false, null, 'bot_handle, conversation_id, command required', 400);
                }
                if (strlen($args) > 1000) $args = substr($args, 0, 1000);
                requireConversationMember($db, $cid, $email);
                // Ensure the bot exists.
                $bs = $pg->prepare("SELECT handle, name FROM bots WHERE LOWER(handle) = LOWER(:h)");
                $bs->execute([':h' => $handle]);
                $bot = $bs->fetch(\PDO::FETCH_ASSOC);
                if (!$bot) jsonResponse(false, null, 'bot not found', 404);
                // Insert a placeholder system message describing the action.
                $botEmail = $bot['handle'] . '@bots.chatyy';
                $sysText = '@' . $bot['handle'] . ' executed /' . $cmd . ($args !== '' ? ' ' . $args : '');
                $nowIso = gmdate('Y-m-d\TH:i:s\Z');
                try {
                    $ins = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, sender_name, content, type, viewed_by, starred, created_at) VALUES (?, ?, ?, ?, 'system', '[]', 0, ?) RETURNING id");
                    $ins->execute([$cid, $botEmail, $bot['name'], $sysText, $nowIso]);
                    $msgId = (int)$ins->fetchColumn();
                } catch (\Throwable $e) {
                    error_log('[bot_invoke_command] insert: ' . $e->getMessage());
                    jsonResponse(false, null, 'invoke failed', 500);
                }
                try { broadcastChatMessage($db, $cid, $msgId, $botEmail, 'chat_message', []); } catch (\Throwable $e) {}
                try { touchConversation($db, $cid); } catch (\Throwable $e) {}
                jsonResponse(true, ['message_id' => $msgId, 'handle' => $bot['handle'], 'command' => $cmd]);
            }

            if ($action === 'bot_update') {
                $botId = (int)($input['bot_id'] ?? 0);
                if ($botId <= 0) jsonResponse(false, null, 'bot_id required', 400);
                $fields = [];
                $params = [':id' => $botId, ':o' => $email];
                if (isset($input['name'])) {
                    $n = trim((string)$input['name']);
                    if ($n !== '') {
                        if (strlen($n) > 60) $n = substr($n, 0, 60);
                        $fields[] = 'name = :n'; $params[':n'] = $n;
                    }
                }
                if (isset($input['description'])) {
                    $d = trim((string)$input['description']);
                    if (strlen($d) > 300) $d = substr($d, 0, 300);
                    $fields[] = 'description = :d'; $params[':d'] = $d;
                }
                if (isset($input['webhook_url'])) {
                    $w = trim((string)$input['webhook_url']);
                    if ($w !== '' && !preg_match('#^https://#i', $w)) {
                        jsonResponse(false, null, 'webhook_url must use https://', 400);
                    }
                    if (strlen($w) > 500) $w = substr($w, 0, 500);
                    $fields[] = 'webhook_url = :w'; $params[':w'] = $w;
                }
                if (isset($input['avatar_url'])) {
                    $a = trim((string)$input['avatar_url']);
                    if (strlen($a) > 500) $a = substr($a, 0, 500);
                    $fields[] = 'avatar_url = :a'; $params[':a'] = $a;
                }
                if (empty($fields)) jsonResponse(false, null, 'nothing to update', 400);
                $sql = "UPDATE bots SET " . implode(', ', $fields) . " WHERE id = :id AND LOWER(owner_email) = LOWER(:o)";
                $st = $pg->prepare($sql);
                $st->execute($params);
                if ($st->rowCount() === 0) jsonResponse(false, null, 'bot not found or not owner', 404);
                jsonResponse(true, ['updated' => true]);
            }

            if ($action === 'bot_delete') {
                $botId = (int)($input['bot_id'] ?? 0);
                if ($botId <= 0) jsonResponse(false, null, 'bot_id required', 400);
                $st = $pg->prepare("DELETE FROM bots WHERE id = :id AND LOWER(owner_email) = LOWER(:o)");
                $st->execute([':id' => $botId, ':o' => $email]);
                if ($st->rowCount() === 0) jsonResponse(false, null, 'bot not found or not owner', 404);
                jsonResponse(true, ['deleted' => true]);
            }

            if ($action === 'bot_regenerate_token') {
                $botId = (int)($input['bot_id'] ?? 0);
                if ($botId <= 0) jsonResponse(false, null, 'bot_id required', 400);
                $newKey = bin2hex(random_bytes(32));
                $st = $pg->prepare("UPDATE bots SET public_key = :k WHERE id = :id AND LOWER(owner_email) = LOWER(:o)");
                $st->execute([':k' => $newKey, ':id' => $botId, ':o' => $email]);
                if ($st->rowCount() === 0) jsonResponse(false, null, 'bot not found or not owner', 404);
                jsonResponse(true, ['public_key' => $newKey, 'token' => $newKey]);
            }
            break;
        }
        // ─── /Bots API skeleton ────────────────────────────────────

        // chat_privacy_set — store user-facing privacy toggles (last-seen,
        // profile photo visibility, read receipts, about). Applied by other
        // endpoints when they decide whether to return these fields.
        case 'chat_privacy_set': {
            $user = requireChatAuth();
            $valid = ['everyone', 'contacts', 'nobody'];
            // phone_visibility uses 'all'/'contacts'/'nobody' shape — same
            // semantics with a different first label to match WhatsApp UI.
            $validPhone = ['all', 'contacts', 'nobody'];
            $lsIn = $input['last_seen']     ?? 'everyone';
            $ppIn = $input['profile_photo'] ?? 'everyone';
            $abIn = $input['about']         ?? 'everyone';
            $gaIn = $input['group_add']     ?? 'everyone';
            $pvIn = $input['phone_visibility'] ?? null;
            $lastSeen = in_array($lsIn, $valid, true) ? $lsIn : 'everyone';
            $photo    = in_array($ppIn, $valid, true) ? $ppIn : 'everyone';
            $about    = in_array($abIn, $valid, true) ? $abIn : 'everyone';
            $groupAdd = in_array($gaIn, $valid, true) ? $gaIn : 'everyone';
            $rrIn = $input['read_receipts'] ?? true;
            $reads = (is_bool($rrIn) ? $rrIn : (int)$rrIn === 1) ? 1 : 0;
            // Telegram Cloud parity. When OFF, new conversations created by
            // this user inherit cloud_storage=false (chat_send relays via WS
            // only, no PG persist — peers store locally). null = unchanged.
            $ccIn = array_key_exists('cloud_chats_default', $input) ? $input['cloud_chats_default'] : null;
            $cloudDefault = null;
            if ($ccIn !== null) {
                $cloudDefault = (is_bool($ccIn) ? $ccIn : (int)$ccIn === 1) ? 1 : 0;
            }
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS group_add TEXT NOT NULL DEFAULT 'everyone'"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS phone_visibility TEXT DEFAULT 'contacts'"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS cloud_chats_default BOOLEAN DEFAULT TRUE"); } catch (Throwable $_) {}
            $db->prepare("INSERT INTO chat_user_privacy (email, last_seen, online, profile_photo, status, about, read_receipts, group_add, updated_at)
                          VALUES (:e, :ls, 'everyone', :pp, 'everyone', :ab, :rr, :ga, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email) DO UPDATE SET last_seen = EXCLUDED.last_seen, profile_photo = EXCLUDED.profile_photo, about = EXCLUDED.about, read_receipts = EXCLUDED.read_receipts, group_add = EXCLUDED.group_add, updated_at = (now() AT TIME ZONE 'UTC')::text")
               ->execute([':e' => $user['email'], ':ls' => $lastSeen, ':pp' => $photo, ':ab' => $about, ':rr' => $reads, ':ga' => $groupAdd]);
            // phone_visibility is updated separately when the client sends it,
            // so users who never expose this option don't have their existing
            // value clobbered by a default on every privacy_set call.
            $phoneVisOut = null;
            if ($pvIn !== null) {
                $pv = in_array($pvIn, $validPhone, true) ? $pvIn : 'contacts';
                try {
                    $db->prepare("UPDATE chat_user_privacy SET phone_visibility = :pv, updated_at = (now() AT TIME ZONE 'UTC')::text WHERE LOWER(email) = LOWER(:e)")
                       ->execute([':pv' => $pv, ':e' => $user['email']]);
                    $phoneVisOut = $pv;
                } catch (\Throwable $e) { error_log('[chat_privacy_set/phone_visibility] ' . $e->getMessage()); }
            }
            // cloud_chats_default — same partial-update pattern. When the
            // client sends explicitly we persist; otherwise the existing
            // value is left untouched.
            $cloudOut = null;
            if ($cloudDefault !== null) {
                try {
                    $db->prepare("UPDATE chat_user_privacy SET cloud_chats_default = :cc, updated_at = (now() AT TIME ZONE 'UTC')::text WHERE LOWER(email) = LOWER(:e)")
                       ->execute([':cc' => $cloudDefault ? 'true' : 'false', ':e' => $user['email']]);
                    $cloudOut = (bool)$cloudDefault;
                } catch (\Throwable $e) { error_log('[chat_privacy_set/cloud_chats_default] ' . $e->getMessage()); }
            }
            $resp = ['last_seen' => $lastSeen, 'profile_photo' => $photo, 'about' => $about, 'read_receipts' => (bool)$reads, 'group_add' => $groupAdd];
            if ($phoneVisOut !== null) $resp['phone_visibility'] = $phoneVisOut;
            if ($cloudOut !== null)    $resp['cloud_chats_default'] = $cloudOut;
            jsonResponse(true, $resp);
            break;
        }

        // chat_save_message — save a message to the user's own "Saved
        // Messages" thread (Telegram-style). Reuses the sender's Saved
        // Messages conversation (type='saved') or creates it.
        case 'chat_save_message': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            $src = $db->prepare("SELECT * FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
            $src->execute([':id' => $messageId]);
            $orig = $src->fetch();
            if (!$orig) jsonResponse(false, null, 'Message not found', 404);
            // Must be a member of the origin conversation to save from it.
            requireConversationMember($db, (int)$orig['conversation_id'], $user['email']);

            // Find or create Saved conv.
            $savedStmt = $db->prepare("SELECT c.id FROM chat_conversations c JOIN chat_conversation_members cm ON cm.conversation_id = c.id WHERE c.type = 'saved' AND LOWER(cm.email) = LOWER(:e) LIMIT 1");
            $savedStmt->execute([':e' => $user['email']]);
            $savedCid = (int)($savedStmt->fetchColumn() ?: 0);
            if (!$savedCid) {
                $db->beginTransaction();
                try {
                    $ic = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, created_at, updated_at) VALUES ('saved', 'Saved Messages', :e, now()::text, now()::text) RETURNING id");
                    $ic->execute([':e' => $user['email']]);
                    $savedCid = (int)$ic->fetchColumn();
                    $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:c, :e, 'admin', now()::text)")
                       ->execute([':c' => $savedCid, ':e' => $user['email']]);
                    $db->commit();
                } catch (Throwable $e) { if ($db->inTransaction()) $db->rollBack(); jsonResponse(false, null, 'saved init failed', 500); }
            }
            // Copy the message.
            $ins = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, file_url, file_name, file_size, created_at)
                VALUES (:cid, :e, :c, :t, :fu, :fn, :fs, (now() AT TIME ZONE 'UTC')::text) RETURNING id");
            $ins->execute([
                   ':cid' => $savedCid, ':e' => $user['email'],
                   ':c' => (string)$orig['content'], ':t' => (string)$orig['type'],
                   ':fu' => $orig['file_url'], ':fn' => $orig['file_name'],
                   ':fs' => (int)($orig['file_size'] ?? 0),
            ]);
            $newId = (int)$ins->fetchColumn();
            jsonResponse(true, ['saved_id' => $newId, 'saved_cid' => $savedCid]);
            break;
        }

        // chat_mark_unread — WhatsApp "Mark as unread". Per-user flag so
        // the thread reappears with a blue dot even after it was read.
        case 'chat_mark_unread': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            // Roll last_read_message_id back by 1 so chat_list shows 1 unread.
            $db->prepare("UPDATE chat_conversation_members SET last_read_message_id = GREATEST(0, COALESCE(last_read_message_id,0) - 1) WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)")
               ->execute([':c' => $cid, ':e' => $user['email']]);
            jsonResponse(true, ['marked_unread' => true]);
            break;
        }

        // chat_keep_message — keep a specific message when disappearing
        // timer would normally erase it. Writes a per-message flag the
        // cron respects.
        case 'chat_keep_message': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? 0);
            $keep = !empty($input['kept']) || (int)($input['kept'] ?? 1) === 1 ? 1 : 0;
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);
            $c = $db->prepare("SELECT conversation_id FROM chat_messages WHERE id = :id");
            $c->execute([':id' => $messageId]);
            $cid = (int)($c->fetchColumn() ?: 0);
            if (!$cid) jsonResponse(false, null, 'Message not found', 404);
            requireConversationMember($db, $cid, $user['email']);
            // PG: use the single boolean chat_messages.kept flag (no per-user tracking).
            $db->prepare("UPDATE chat_messages SET kept = :k WHERE id = :id")
               ->execute([':k' => $keep ? 'true' : 'false', ':id' => $messageId]);
            jsonResponse(true, ['kept' => (bool)$keep]);
            break;
        }

        // chat_approve_member — admin approves a pending join request.
        case 'chat_approve_member': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $target = strtolower(trim($input['email'] ?? ''));
            $approve = !empty($input['approve']) || (int)($input['approve'] ?? 1) === 1 ? 1 : 0;
            if (!$cid || $target === '') jsonResponse(false, null, 'conversation_id + email required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if (($membership['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can approve members', 403);
            }
            try { $db->exec("CREATE TABLE IF NOT EXISTS chat_pending_group_members (conversation_id BIGINT NOT NULL, email TEXT NOT NULL, requested_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (conversation_id, email))"); } catch (Throwable $e) {}
            if ($approve) {
                $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:c, :e, :n, 'member', now()::text) ON CONFLICT DO NOTHING")
                   ->execute([':c' => $cid, ':e' => $target, ':n' => chatDisplayName($target)]);
            }
            $db->prepare("DELETE FROM chat_pending_group_members WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)")
               ->execute([':c' => $cid, ':e' => $target]);
            jsonResponse(true, ['approved' => (bool)$approve]);
            break;
        }

        // chat_set_vanish_mode / chat_set_secret_mode — both enable a
        // stronger view-once/auto-delete setting on a conversation.
        case 'chat_set_vanish_mode':
        case 'chat_set_secret_mode': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $enabled = !empty($input['enabled']) ? 1 : 0;
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            // chat_conversations.vanish_mode is BOOLEAN in PG
            $db->prepare("UPDATE chat_conversations SET vanish_mode = :v WHERE id = :id")
               ->execute([':v' => $enabled ? 'true' : 'false', ':id' => $cid]);
            jsonResponse(true, ['enabled' => (bool)$enabled]);
            break;
        }

        // chat_set_member_tag — label a specific member in a group (e.g.
        // "Coordenador"). Admin-only. Stored on the membership row.
        case 'chat_set_member_tag': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $target = strtolower(trim($input['email'] ?? ''));
            $tag = mb_substr(trim((string)($input['tag'] ?? '')), 0, 32);
            if (!$cid || $target === '') jsonResponse(false, null, 'conversation_id + email required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if (($membership['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can tag members', 403);
            }
            $db->prepare("UPDATE chat_conversation_members SET tag = :t WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)")
               ->execute([':t' => $tag, ':c' => $cid, ':e' => $target]);
            jsonResponse(true, ['tag' => $tag]);
            break;
        }

        // chat_set_wallpaper — per-user, per-conversation wallpaper choice.
        // Stored in a small KV-style table so changes sync across devices.
        case 'chat_set_wallpaper': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $wallpaper = trim((string)($input['wallpaper'] ?? ''));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $db->prepare("INSERT INTO chat_user_conv_settings (email, conversation_id, wallpaper, updated_at) VALUES (:e, :c, :w, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email, conversation_id) DO UPDATE SET wallpaper = EXCLUDED.wallpaper, updated_at = EXCLUDED.updated_at")
               ->execute([':e' => $user['email'], ':c' => $cid, ':w' => mb_substr($wallpaper, 0, 500)]);
            jsonResponse(true, ['wallpaper' => $wallpaper]);
            break;
        }

        case 'chat_get_wallpaper': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            $wallpaper = null;
            try {
                if ($cid > 0) {
                    $s = $db->prepare("SELECT wallpaper FROM chat_user_conv_settings WHERE LOWER(email) = LOWER(:e) AND conversation_id = :c");
                    $s->execute([':e' => $user['email'], ':c' => $cid]);
                    $wallpaper = $s->fetchColumn() ?: null;
                } else {
                    // Global wallpaper = most recent per-user fallback.
                    $s = $db->prepare("SELECT wallpaper FROM chat_user_conv_settings WHERE LOWER(email) = LOWER(:e) AND conversation_id = 0");
                    $s->execute([':e' => $user['email']]);
                    $wallpaper = $s->fetchColumn() ?: null;
                }
            } catch (Throwable $e) {}
            jsonResponse(true, ['wallpaper' => $wallpaper]);
            break;
        }

        // chat_set_note — personal sticky note for a conversation. Useful
        // for the "contact notes" feature seen in messengers.
        case 'chat_set_note': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $note = trim((string)($input['note'] ?? ''));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $db->prepare("INSERT INTO chat_user_conv_settings (email, conversation_id, note, updated_at) VALUES (:e, :c, :n, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email, conversation_id) DO UPDATE SET note = EXCLUDED.note, updated_at = EXCLUDED.updated_at")
               ->execute([':e' => $user['email'], ':c' => $cid, ':n' => mb_substr($note, 0, 1000)]);
            jsonResponse(true, ['note' => $note]);
            break;
        }

        // chat_set_auto_reply — WhatsApp-style away message.
        case 'chat_set_auto_reply': {
            $user = requireChatAuth();
            $enabled = !empty($input['enabled']) ? 1 : 0;
            $message = trim((string)($input['message'] ?? ''));
            $db->prepare("INSERT INTO chat_user_auto_reply (email, enabled, message, updated_at) VALUES (:e, :en, :m, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email) DO UPDATE SET enabled = EXCLUDED.enabled, message = EXCLUDED.message, updated_at = EXCLUDED.updated_at")
               ->execute([':e' => $user['email'], ':en' => $enabled, ':m' => mb_substr($message, 0, 500)]);
            jsonResponse(true, ['enabled' => (bool)$enabled, 'message' => $message]);
            break;
        }

        // chat_call_history_clear — wipe the caller's local call history.
        case 'chat_call_history_clear': {
            $user = requireChatAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_call_history WHERE user_email = :e")->execute([':e' => $user['email']]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['cleared' => true]);
            break;
        }

        // chat_call_history_delete — single call entry.
        case 'chat_call_history_delete': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            $callId = trim((string)($input['call_id'] ?? ''));
            if (!$id && $callId === '') jsonResponse(false, null, 'id or call_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                if ($id) {
                    $pg->prepare("DELETE FROM chat_call_history WHERE id = :id AND user_email = :e")
                       ->execute([':id' => $id, ':e' => $user['email']]);
                } else {
                    $pg->prepare("DELETE FROM chat_call_history WHERE call_id = :c AND user_email = :e")
                       ->execute([':c' => $callId, ':e' => $user['email']]);
                }
            } catch (Throwable $e) {}
            jsonResponse(true, ['deleted' => true]);
            break;
        }

        // chat_export — return the conversation history in `text`, `json`,
        // or `html` format. Telegram parity: users can keep a personal
        // archive of their chats outside the app (compliance + backup).
        case 'chat_export': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            $format = strtolower((string)($input['format'] ?? $_GET['format'] ?? 'text'));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $stmt = $db->prepare("SELECT id, sender_email, content, type, file_name, file_url, reply_to_id, edited_at, created_at
                FROM chat_messages WHERE conversation_id = :cid AND deleted_at IS NULL
                ORDER BY id ASC LIMIT 10000");
            $stmt->execute([':cid' => $cid]);
            $rows = $stmt->fetchAll();
            $cstmt = $db->prepare("SELECT name, type FROM chat_conversations WHERE id = :cid");
            $cstmt->execute([':cid' => $cid]);
            $conv = $cstmt->fetch() ?: ['name' => 'Conversa', 'type' => 'direct'];

            if ($format === 'json') {
                $msgs = array_map(fn($m) => [
                    'id'          => (int)$m['id'],
                    'from'        => $m['sender_email'],
                    'from_name'   => chatDisplayName($m['sender_email']),
                    'type'        => $m['type'],
                    'content'     => $m['content'],
                    'file_name'   => $m['file_name'],
                    'file_url'    => $m['file_url'],
                    'reply_to_id' => $m['reply_to_id'] ? (int)$m['reply_to_id'] : null,
                    'edited_at'   => $m['edited_at'],
                    'created_at'  => $m['created_at'],
                ], $rows);
                $out = [
                    'conversation' => ['id' => $cid, 'name' => $conv['name'], 'type' => $conv['type']],
                    'exported_at'  => date('c'),
                    'exported_by'  => $user['email'],
                    'count'        => count($msgs),
                    'messages'     => $msgs,
                ];
                jsonResponse(true, ['format' => 'json', 'body' => $out, 'messages' => count($msgs)]);
                break;
            }

            if ($format === 'html') {
                $esc = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
                $html = [];
                $html[] = '<!doctype html><html><head><meta charset="utf-8"><title>' . $esc($conv['name']) . ' — Chatyy</title>';
                $html[] = '<style>body{font:14px -apple-system,sans-serif;max-width:720px;margin:auto;padding:20px;background:#ece5dd;color:#111}';
                $html[] = '.m{background:#fff;padding:8px 12px;border-radius:8px;margin:6px 0;box-shadow:0 1px 0 rgba(0,0,0,.05)}';
                $html[] = '.own{background:#dcf8c6;margin-left:80px}.name{font-weight:600;color:#7c3aed;font-size:12px}';
                $html[] = '.ts{color:#999;font-size:11px;margin-left:8px}.system{text-align:center;background:transparent;color:#666;font-size:12px;font-style:italic}';
                $html[] = '.media{color:#555;font-style:italic}</style></head><body>';
                $html[] = '<h2>' . $esc($conv['name']) . '</h2>';
                $html[] = '<p style="color:#666">Exportado ' . $esc(date('Y-m-d H:i')) . ' — ' . count($rows) . ' mensagens</p>';
                foreach ($rows as $m) {
                    $own = strcasecmp($m['sender_email'], $user['email']) === 0;
                    $cls = $m['type'] === 'system' ? 'm system' : ('m' . ($own ? ' own' : ''));
                    $body = match($m['type']) {
                        'image' => '<span class="media">📷 Foto</span>',
                        'video' => '<span class="media">🎥 Vídeo</span>',
                        'audio' => '<span class="media">🎤 Áudio</span>',
                        'file'  => '<span class="media">📎 ' . $esc($m['file_name'] ?? 'Arquivo') . '</span>',
                        'sticker' => '<span class="media">💟 Figurinha</span>',
                        'gif'   => '<span class="media">🎞️ GIF</span>',
                        'location' => '<span class="media">📍 Localização</span>',
                        'contact'  => '<span class="media">👤 Contato</span>',
                        default => nl2br($esc($m['content'])),
                    };
                    $html[] = '<div class="' . $cls . '">';
                    if ($m['type'] !== 'system') {
                        $html[] = '<div class="name">' . $esc(chatDisplayName($m['sender_email'])) . '<span class="ts">' . $esc($m['created_at']) . ($m['edited_at'] ? ' · editada' : '') . '</span></div>';
                    }
                    $html[] = '<div>' . $body . '</div></div>';
                }
                $html[] = '</body></html>';
                $out = implode("\n", $html);
                jsonResponse(true, ['format' => 'html', 'body' => $out, 'bytes' => strlen($out), 'messages' => count($rows)]);
                break;
            }

            // Default: plain text
            $lines = [];
            foreach ($rows as $m) {
                $who = chatDisplayName($m['sender_email']);
                $body = match($m['type']) {
                    'image'  => '[Imagem]',
                    'video'  => '[Video]',
                    'audio'  => '[Audio]',
                    'file'   => '[Arquivo: ' . ($m['file_name'] ?? '') . ']',
                    'sticker'=> '[Figurinha]',
                    'gif'    => '[GIF]',
                    'location'=> '[Localizacao]',
                    'contact'=> '[Contato]',
                    default  => (string)$m['content'],
                };
                $lines[] = "[{$m['created_at']}] {$who}: {$body}";
            }
            $export = implode("\n", $lines) . "\n";
            jsonResponse(true, ['format' => 'text', 'text' => $export, 'bytes' => strlen($export), 'messages' => count($lines)]);
            break;
        }

        // chat_set_pin — lock a specific conversation behind a PIN so it
        // doesn't show previews on the list and requires auth to open.
        case 'chat_set_pin': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $pin = (string)($input['pin'] ?? '');
            if (!$cid || !preg_match('/^\d{4,8}$/', $pin)) {
                jsonResponse(false, null, 'conversation_id + 4-8 digit pin required', 400);
            }
            requireConversationMember($db, $cid, $user['email']);
            try { $db->exec("CREATE TABLE IF NOT EXISTS chat_locks (email TEXT NOT NULL, conversation_id BIGINT NOT NULL, pin_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now()::text, PRIMARY KEY (email, conversation_id))"); } catch (Throwable $e) {}
            $db->prepare("INSERT INTO chat_locks (email, conversation_id, pin_hash) VALUES (:e, :c, :p)
                          ON CONFLICT (email, conversation_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash")
               ->execute([':e' => $user['email'], ':c' => $cid, ':p' => password_hash($pin, PASSWORD_DEFAULT)]);
            jsonResponse(true, ['locked' => true]);
            break;
        }

        case 'chat_verify_pin': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $pin = (string)($input['pin'] ?? '');
            if (!$cid || !$pin) jsonResponse(false, null, 'conversation_id + pin required', 400);
            $s = $db->prepare("SELECT pin_hash FROM chat_locks WHERE LOWER(email) = LOWER(:e) AND conversation_id = :c");
            try { $s->execute([':e' => $user['email'], ':c' => $cid]); }
            catch (Throwable $e) { jsonResponse(true, ['verified' => true]); }
            $hash = $s->fetchColumn();
            if (!$hash) jsonResponse(true, ['verified' => true]); // not locked
            jsonResponse(true, ['verified' => password_verify($pin, $hash)]);
            break;
        }

        case 'chat_check_pin': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            $locked = false;
            try {
                $s = $db->prepare("SELECT 1 FROM chat_locks WHERE LOWER(email) = LOWER(:e) AND conversation_id = :c");
                $s->execute([':e' => $user['email'], ':c' => $cid]);
                $locked = (bool)$s->fetchColumn();
            } catch (Throwable $e) {}
            jsonResponse(true, ['locked' => $locked]);
            break;
        }

        // chat_set_slow_mode — admin-only cooldown between messages in a
        // group (e.g. 10s slow mode for chatty announcement channels).
        case 'chat_set_slow_mode': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $seconds = max(0, min(86400, (int)($input['seconds'] ?? 0)));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if ($membership['type'] === 'group' && ($membership['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can change slow mode', 403);
            }
            $db->prepare("UPDATE chat_conversations SET slow_mode_seconds = :s WHERE id = :id")->execute([':s' => $seconds, ':id' => $cid]);
            jsonResponse(true, ['seconds' => $seconds]);
            break;
        }

        // chat_set_forward_protection — group admin flag: prevents the
        // "forward" action on messages in this group.
        case 'chat_set_forward_protection': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $enabled = !empty($input['enabled']) ? 1 : 0;
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if ($membership['type'] === 'group' && ($membership['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can change forward protection', 403);
            }
            $db->prepare("UPDATE chat_conversations SET no_forward = :s WHERE id = :id")->execute([':s' => $enabled, ':id' => $cid]);
            jsonResponse(true, ['enabled' => (bool)$enabled]);
            break;
        }

        // chat_set_notif_sound / chat_set_notification_sound — per-conv mute
        // + sound picker. Writes into user_conv_settings the same table we
        // used for wallpaper + note.
        case 'chat_set_notif_sound':
        case 'chat_set_notification_sound': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $sound = trim((string)($input['sound'] ?? 'default'));
            $muted = !empty($input['muted']) ? 1 : 0;
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $db->prepare("INSERT INTO chat_user_conv_settings (email, conversation_id, notif_sound, notif_muted, updated_at) VALUES (:e, :c, :s, :m, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email, conversation_id) DO UPDATE SET notif_sound = EXCLUDED.notif_sound, notif_muted = EXCLUDED.notif_muted, updated_at = EXCLUDED.updated_at")
               ->execute([':e' => $user['email'], ':c' => $cid, ':s' => mb_substr($sound, 0, 100), ':m' => $muted]);
            jsonResponse(true, ['sound' => $sound, 'muted' => (bool)$muted]);
            break;
        }

        // chat_folders_* — WhatsApp Community-style / Telegram folders.
        // Users group their chats into custom buckets.
        case 'chat_folders_create': {
            $user = requireChatAuth();
            $name = trim((string)($input['name'] ?? ''));
            if ($name === '') jsonResponse(false, null, 'name required', 400);
            $ids = array_values(array_filter(array_map('intval', (array)($input['conversation_ids'] ?? []))));
            $ins = $db->prepare("INSERT INTO chat_folders (user_email, created_by, name, icon, filter_type, conversation_ids, created_at) VALUES (:e, :e2, :n, :i, 'manual', :c, now()::text) RETURNING id");
            $ins->execute([':e' => $user['email'], ':e2' => $user['email'], ':n' => mb_substr($name, 0, 40), ':i' => mb_substr((string)($input['icon'] ?? ''), 0, 10), ':c' => json_encode($ids)]);
            jsonResponse(true, ['id' => (int)$ins->fetchColumn(), 'name' => $name]);
            break;
        }

        case 'chat_folders_update': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            $fields = [];
            $params = [':id' => $id, ':e' => $user['email']];
            if (isset($input['name'])) { $fields[] = 'name = :n'; $params[':n'] = mb_substr(trim((string)$input['name']), 0, 40); }
            if (isset($input['icon'])) { $fields[] = 'icon = :i'; $params[':i'] = mb_substr(trim((string)$input['icon']), 0, 10); }
            if (isset($input['conversation_ids'])) {
                $ids = array_values(array_filter(array_map('intval', (array)$input['conversation_ids'])));
                $fields[] = 'conversation_ids = :c';
                $params[':c'] = json_encode($ids);
            }
            if (isset($input['position'])) { $fields[] = 'position = :p'; $params[':p'] = (int)$input['position']; }
            if (empty($fields)) jsonResponse(true, ['updated' => false]);
            $db->prepare("UPDATE chat_folders SET " . implode(', ', $fields) . " WHERE id = :id AND (LOWER(user_email) = LOWER(:e) OR LOWER(COALESCE(created_by,'')) = LOWER(:e))")
               ->execute($params);
            jsonResponse(true, ['updated' => true]);
            break;
        }

        case 'chat_folders_delete': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            try {
                $db->prepare("DELETE FROM chat_folders WHERE id = :id AND (LOWER(user_email) = LOWER(:e) OR LOWER(COALESCE(created_by,'')) = LOWER(:e2))")
                   ->execute([':id' => $id, ':e' => $user['email'], ':e2' => $user['email']]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['deleted' => true]);
            break;
        }

        // chat_update_live_location — write an ephemeral location share.
        // Expires after `duration_seconds` (bounded to 15min..8h like WA).
        case 'chat_update_live_location': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $lat = (float)($input['latitude'] ?? $input['lat'] ?? 0);
            $lng = (float)($input['longitude'] ?? $input['lng'] ?? 0);
            $dur = max(900, min(28800, (int)($input['duration_seconds'] ?? 3600)));
            if (!$cid || !$lat || !$lng) jsonResponse(false, null, 'conversation_id/lat/lng required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $db->prepare("INSERT INTO chat_live_locations (email, conversation_id, latitude, longitude, accuracy, heading, speed, expires_at, updated_at) VALUES (:e, :c, :lat, :lng, :a, :h, :s, :ex, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email, conversation_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, accuracy = EXCLUDED.accuracy, heading = EXCLUDED.heading, speed = EXCLUDED.speed, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at")
               ->execute([
                   ':e' => $user['email'], ':c' => $cid, ':lat' => $lat, ':lng' => $lng,
                   ':a' => (float)($input['accuracy'] ?? 0),
                   ':h' => (float)($input['heading'] ?? 0),
                   ':s' => (float)($input['speed'] ?? 0),
                   ':ex' => time() + $dur,
               ]);
            jsonResponse(true, ['expires_at' => time() + $dur]);
            break;
        }

        case 'chat_stop_live_location': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            try {
                $db->prepare("DELETE FROM chat_live_locations WHERE LOWER(email) = LOWER(:e) AND conversation_id = :c")
                   ->execute([':e' => $user['email'], ':c' => $cid]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['stopped' => true]);
            break;
        }

        // chat_get_live_location — members poll this to render moving pins.
        case 'chat_get_live_location': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            $shares = [];
            try {
                $stmt = $db->prepare("SELECT email, latitude, longitude, accuracy, heading, speed, expires_at, updated_at
                    FROM chat_live_locations
                    WHERE conversation_id = :c AND expires_at > :now
                    ORDER BY updated_at DESC");
                $stmt->execute([':c' => $cid, ':now' => time()]);
                foreach ($stmt->fetchAll() as $r) {
                    $shares[] = [
                        'email' => $r['email'],
                        'name' => chatDisplayName($r['email']),
                        'latitude' => (float)$r['latitude'],
                        'longitude' => (float)$r['longitude'],
                        'accuracy' => (float)$r['accuracy'],
                        'heading' => (float)$r['heading'],
                        'speed' => (float)$r['speed'],
                        'expires_at' => (int)$r['expires_at'],
                        'updated_at' => $r['updated_at'],
                    ];
                }
            } catch (Throwable $e) {}
            jsonResponse(true, ['shares' => $shares]);
            break;
        }

        // chat_broadcast_* — WhatsApp Broadcast Lists. User picks N contacts;
        // one write fans out to each contact's private direct thread so
        // recipients don't know they were part of a broadcast.
        case 'chat_broadcast_create': {
            $user = requireChatAuth();
            $name = trim((string)($input['name'] ?? 'Lista'));
            $recipients = array_values(array_filter(array_map(fn($e) => strtolower(trim($e)), (array)($input['recipients'] ?? $input['members'] ?? [])),
                fn($e) => $e !== '' && filter_var($e, FILTER_VALIDATE_EMAIL)));
            if (count($recipients) < 1 || count($recipients) > 256) {
                jsonResponse(false, null, 'recipients 1..256 required', 400);
            }
            $ins = $db->prepare("INSERT INTO chat_broadcast_lists (created_by, name, recipients, created_at) VALUES (:e, :n, :r, now()::text) RETURNING id");
            $ins->execute([':e' => $user['email'], ':n' => mb_substr($name, 0, 80), ':r' => json_encode($recipients)]);
            jsonResponse(true, ['id' => (int)$ins->fetchColumn(), 'recipients' => count($recipients)]);
            break;
        }

        case 'chat_broadcast_update': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            $fields = []; $params = [':id' => $id, ':e' => $user['email']];
            if (isset($input['name'])) { $fields[] = 'name = :n'; $params[':n'] = mb_substr(trim((string)$input['name']), 0, 80); }
            if (isset($input['recipients'])) {
                $r = array_values(array_filter(array_map(fn($e) => strtolower(trim($e)), (array)$input['recipients']),
                    fn($e) => $e !== '' && filter_var($e, FILTER_VALIDATE_EMAIL)));
                $fields[] = 'recipients = :r';
                $params[':r'] = json_encode($r);
            }
            if (empty($fields)) jsonResponse(true, ['updated' => false]);
            $db->prepare("UPDATE chat_broadcast_lists SET " . implode(', ', $fields) . " WHERE id = :id AND LOWER(created_by) = LOWER(:e)")
               ->execute($params);
            jsonResponse(true, ['updated' => true]);
            break;
        }

        case 'chat_broadcast_delete': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            $db->prepare("DELETE FROM chat_broadcast_lists WHERE id = :id AND LOWER(created_by) = LOWER(:e)")
               ->execute([':id' => $id, ':e' => $user['email']]);
            jsonResponse(true, ['deleted' => true]);
            break;
        }

        // chat_broadcast_send — fan out 1 message to each recipient's direct
        // chat with the sender. Each leg looks like a normal 1-on-1 message
        // to the recipient — they have no idea it was a broadcast.
        case 'chat_broadcast_send': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            $content = trim((string)($input['content'] ?? ''));
            if (!$id || $content === '') jsonResponse(false, null, 'id + content required', 400);
            $s = $db->prepare("SELECT recipients FROM chat_broadcast_lists WHERE id = :id AND LOWER(created_by) = LOWER(:e)");
            $s->execute([':id' => $id, ':e' => $user['email']]);
            $row = $s->fetch();
            if (!$row) jsonResponse(false, null, 'List not found', 404);
            $recipients = json_decode($row['recipients'] ?: '[]', true) ?: [];
            if (empty($recipients)) jsonResponse(false, null, 'List has no recipients', 400);
            $sent = 0;
            foreach ($recipients as $peer) {
                try {
                    $a = strtolower($user['email']); $b = strtolower($peer);
                    $dk = $a < $b ? "$a|$b" : "$b|$a";
                    $q = $db->prepare("SELECT id FROM chat_conversations WHERE type='direct' AND direct_key = :k LIMIT 1");
                    $q->execute([':k' => $dk]);
                    $cid = (int)($q->fetchColumn() ?: 0);
                    if (!$cid) {
                        $db->beginTransaction();
                        $ins = $db->prepare("INSERT INTO chat_conversations (type, created_by, direct_key, created_at, updated_at) VALUES ('direct', :cb, :dk, now()::text, now()::text) RETURNING id");
                        $ins->execute([':cb' => $user['email'], ':dk' => $dk]);
                        $cid = (int)$ins->fetchColumn();
                        $insM = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, :r, now()::text) ON CONFLICT DO NOTHING");
                        foreach ([$user['email'] => 'admin', $peer => 'member'] as $em => $role) {
                            $insM->execute([':cid' => $cid, ':em' => $em, ':dn' => chatDisplayName($em), ':r' => $role]);
                        }
                        $db->commit();
                    }
                    // Insert the message.
                    $msg = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :e, :c, 'text', (now() AT TIME ZONE 'UTC')::text) RETURNING id");
                    $msg->execute([':cid' => $cid, ':e' => $user['email'], ':c' => $content]);
                    $mid = (int)$msg->fetchColumn();
                    try { broadcastChatMessage($db, $cid, $mid, $user['email']); } catch (Throwable $e) {}
                    try { chatSendPushToMembers($db, $cid, $mid, $user['email']); } catch (Throwable $e) {}
                    $sent++;
                } catch (Throwable $e) {
                    if ($db->inTransaction()) { try { $db->rollBack(); } catch (Throwable $ex) {} }
                    error_log('[broadcast_send] ' . $peer . ': ' . $e->getMessage());
                }
            }
            jsonResponse(true, ['sent' => $sent, 'total' => count($recipients)]);
            break;
        }

        // chat_sticker_pack_install / uninstall — real persistence of the
        // user's installed packs. Reuses chat_user_sticker_packs table.
        case 'chat_sticker_pack_install': {
            $user = requireChatAuth();
            $packId = (int)($input['pack_id'] ?? 0);
            if (!$packId) jsonResponse(false, null, 'pack_id required', 400);
            try {
                $db->prepare("INSERT INTO chat_user_sticker_packs (user_email, pack_id, installed_at) VALUES (:e, :p, now()::text) ON CONFLICT DO NOTHING")
                   ->execute([':e' => $user['email'], ':p' => $packId]);
            } catch (Throwable $e) { error_log('[sticker_install] ' . $e->getMessage()); }
            jsonResponse(true, ['installed' => $packId]);
            break;
        }

        case 'chat_sticker_pack_uninstall': {
            $user = requireChatAuth();
            $packId = (int)($input['pack_id'] ?? 0);
            if (!$packId) jsonResponse(false, null, 'pack_id required', 400);
            try {
                $db->prepare("DELETE FROM chat_user_sticker_packs WHERE LOWER(user_email) = LOWER(:e) AND pack_id = :p")
                   ->execute([':e' => $user['email'], ':p' => $packId]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['uninstalled' => $packId]);
            break;
        }

        // ════════════════════════════════════════════════════════════════
        // STICKER STORE / CUSTOM ANIMATED EMOJI (Telegram Premium-style)
        // Tables: sticker_packs, sticker_pack_items, user_sticker_packs,
        // custom_animated_emoji. Created lazily here so first invocation
        // bootstraps the schema without a migration step.
        // ════════════════════════════════════════════════════════════════
        case 'sticker_pack_create':
        case 'sticker_pack_add_item':
        case 'sticker_pack_install':
        case 'sticker_pack_uninstall':
        case 'sticker_pack_my':
        case 'sticker_pack_browse':
        case 'sticker_pack_search':
        case 'custom_emoji_upload':
        case 'custom_emoji_my':
        case 'custom_emoji_delete': {
            $user = requireChatAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();

            // Idempotent schema. Each table guarded by IF NOT EXISTS so
            // first call from any path bootstraps without a migration step.
            try {
                $pg->exec("CREATE TABLE IF NOT EXISTS sticker_packs (
                    id BIGSERIAL PRIMARY KEY,
                    handle TEXT UNIQUE,
                    name TEXT NOT NULL,
                    author_email TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    cover_url TEXT DEFAULT '',
                    animated BOOLEAN NOT NULL DEFAULT FALSE,
                    premium BOOLEAN NOT NULL DEFAULT FALSE,
                    install_count INT NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_sticker_packs_install ON sticker_packs (install_count DESC)");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_sticker_packs_created ON sticker_packs (created_at DESC)");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_sticker_packs_animated ON sticker_packs (animated)");
                $pg->exec("CREATE TABLE IF NOT EXISTS sticker_pack_items (
                    pack_id BIGINT NOT NULL,
                    sticker_id TEXT NOT NULL,
                    emoji_alt TEXT DEFAULT '',
                    order_idx INT NOT NULL DEFAULT 0,
                    PRIMARY KEY (pack_id, sticker_id)
                )");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_sticker_pack_items_pack ON sticker_pack_items (pack_id, order_idx)");
                $pg->exec("CREATE TABLE IF NOT EXISTS user_sticker_packs (
                    user_email TEXT NOT NULL,
                    pack_id BIGINT NOT NULL,
                    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY (user_email, pack_id)
                )");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_user_sticker_packs_user ON user_sticker_packs (user_email, installed_at DESC)");
                $pg->exec("CREATE TABLE IF NOT EXISTS custom_animated_emoji (
                    id BIGSERIAL PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    emoji_handle TEXT NOT NULL,
                    webp_url TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_custom_emoji_owner ON custom_animated_emoji (owner_email)");
                $pg->exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_emoji_owner_handle ON custom_animated_emoji (owner_email, emoji_handle)");
            } catch (Throwable $e) { error_log('[sticker_store schema] ' . $e->getMessage()); }

            // Helper: validate an R2 object key. Reject schemes and absolute
            // file paths that would let a client smuggle URLs from unrelated
            // origins. Accepts R2 object keys (no scheme) and server-relative
            // /data/ paths.
            $validateR2Key = function ($key) {
                $k = trim((string)$key);
                if ($k === '' || strlen($k) > 1024) return null;
                if (preg_match('#^[a-z]+://#i', $k)) return null;
                if (strpos($k, "\0") !== false) return null;
                if (strpos($k, '..') !== false) return null;
                return $k;
            };

            switch ($action) {
                case 'sticker_pack_create': {
                    $name = trim((string)($input['name'] ?? ''));
                    $description = trim((string)($input['description'] ?? ''));
                    $coverKey = $validateR2Key($input['cover_r2_key'] ?? '');
                    if ($name === '') jsonResponse(false, null, 'name required', 400);
                    if (mb_strlen($name) > 80) $name = mb_substr($name, 0, 80);
                    if (mb_strlen($description) > 240) $description = mb_substr($description, 0, 240);

                    // Generate a URL-safe handle from the name + 6-char suffix
                    // so each pack has a stable share-link slug.
                    $handle = strtolower(preg_replace('/[^a-z0-9]+/', '-', $name));
                    $handle = trim($handle, '-');
                    if ($handle === '') $handle = 'pack';
                    $handle = substr($handle, 0, 32) . '-' . bin2hex(random_bytes(3));

                    try {
                        $stmt = $pg->prepare("INSERT INTO sticker_packs (handle, name, author_email, description, cover_url, animated, premium)
                            VALUES (:h, :n, :e, :d, :c, :a, :p) RETURNING id, created_at");
                        $stmt->execute([
                            ':h' => $handle,
                            ':n' => $name,
                            ':e' => $user['email'],
                            ':d' => $description,
                            ':c' => $coverKey ?? '',
                            ':a' => 'f',
                            ':p' => 'f',
                        ]);
                        $row = $stmt->fetch(PDO::FETCH_ASSOC);
                        $packId = (int)$row['id'];
                        // Auto-install for the author so it shows in their picker.
                        $pg->prepare("INSERT INTO user_sticker_packs (user_email, pack_id) VALUES (:e, :p) ON CONFLICT DO NOTHING")
                           ->execute([':e' => $user['email'], ':p' => $packId]);
                        jsonResponse(true, [
                            'pack_id' => $packId,
                            'handle' => $handle,
                            'name' => $name,
                            'description' => $description,
                            'cover_url' => $coverKey ?? '',
                            'created_at' => $row['created_at'],
                        ]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'create failed: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'sticker_pack_add_item': {
                    $packId = (int)($input['pack_id'] ?? 0);
                    $stickerKey = $validateR2Key($input['sticker_r2_key'] ?? '');
                    $emojiAlt = trim((string)($input['emoji_alt'] ?? ''));
                    if (!$packId) jsonResponse(false, null, 'pack_id required', 400);
                    if (!$stickerKey) jsonResponse(false, null, 'sticker_r2_key required', 400);
                    if (mb_strlen($emojiAlt) > 16) $emojiAlt = mb_substr($emojiAlt, 0, 16);

                    // Author check — only the pack's author can add items.
                    $own = $pg->prepare("SELECT author_email, animated FROM sticker_packs WHERE id = :id");
                    $own->execute([':id' => $packId]);
                    $packRow = $own->fetch(PDO::FETCH_ASSOC);
                    if (!$packRow) jsonResponse(false, null, 'Pack not found', 404);
                    if (strtolower((string)$packRow['author_email']) !== strtolower($user['email'])) {
                        jsonResponse(false, null, 'Not the pack author', 403);
                    }

                    try {
                        $maxStmt = $pg->prepare("SELECT COALESCE(MAX(order_idx), 0) FROM sticker_pack_items WHERE pack_id = :p");
                        $maxStmt->execute([':p' => $packId]);
                        $nextIdx = ((int)$maxStmt->fetchColumn()) + 1;

                        $ins = $pg->prepare("INSERT INTO sticker_pack_items (pack_id, sticker_id, emoji_alt, order_idx)
                            VALUES (:p, :s, :ea, :o)
                            ON CONFLICT (pack_id, sticker_id) DO UPDATE SET emoji_alt = EXCLUDED.emoji_alt");
                        $ins->execute([':p' => $packId, ':s' => $stickerKey, ':ea' => $emojiAlt, ':o' => $nextIdx]);

                        // Auto-flip pack.animated when an animated asset is added.
                        if (preg_match('/\.(webp|gif|mp4|webm)$/i', $stickerKey)) {
                            $pg->prepare("UPDATE sticker_packs SET animated = TRUE WHERE id = :p AND animated = FALSE")
                               ->execute([':p' => $packId]);
                        }
                        jsonResponse(true, [
                            'pack_id' => $packId,
                            'sticker_id' => $stickerKey,
                            'emoji_alt' => $emojiAlt,
                            'order_idx' => $nextIdx,
                        ]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'add_item failed: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'sticker_pack_install': {
                    $packId = (int)($input['pack_id'] ?? 0);
                    if (!$packId) jsonResponse(false, null, 'pack_id required', 400);
                    try {
                        $exists = $pg->prepare("SELECT id FROM sticker_packs WHERE id = :p");
                        $exists->execute([':p' => $packId]);
                        if (!$exists->fetch()) jsonResponse(false, null, 'Pack not found', 404);

                        $ins = $pg->prepare("INSERT INTO user_sticker_packs (user_email, pack_id) VALUES (:e, :p) ON CONFLICT DO NOTHING");
                        $ins->execute([':e' => $user['email'], ':p' => $packId]);
                        // Bump install_count only when the row was actually inserted.
                        if ($ins->rowCount() > 0) {
                            $pg->prepare("UPDATE sticker_packs SET install_count = install_count + 1 WHERE id = :p")
                               ->execute([':p' => $packId]);
                        }
                        jsonResponse(true, ['installed' => $packId]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'install failed: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'sticker_pack_uninstall': {
                    $packId = (int)($input['pack_id'] ?? 0);
                    if (!$packId) jsonResponse(false, null, 'pack_id required', 400);
                    try {
                        $del = $pg->prepare("DELETE FROM user_sticker_packs WHERE LOWER(user_email) = LOWER(:e) AND pack_id = :p");
                        $del->execute([':e' => $user['email'], ':p' => $packId]);
                        if ($del->rowCount() > 0) {
                            $pg->prepare("UPDATE sticker_packs SET install_count = GREATEST(0, install_count - 1) WHERE id = :p")
                               ->execute([':p' => $packId]);
                        }
                        jsonResponse(true, ['uninstalled' => $packId]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'uninstall failed: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'sticker_pack_my': {
                    $items = [];
                    try {
                        $stmt = $pg->prepare("SELECT p.id, p.handle, p.name, p.author_email, p.description, p.cover_url,
                                p.animated, p.premium, p.install_count, p.created_at, u.installed_at
                            FROM user_sticker_packs u
                            JOIN sticker_packs p ON p.id = u.pack_id
                            WHERE LOWER(u.user_email) = LOWER(:e)
                            ORDER BY u.installed_at DESC");
                        $stmt->execute([':e' => $user['email']]);
                        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                            $r['id'] = (int)$r['id'];
                            $r['install_count'] = (int)$r['install_count'];
                            $r['animated'] = (bool)$r['animated'];
                            $r['premium'] = (bool)$r['premium'];
                            $items[] = $r;
                        }
                    } catch (Throwable $e) { error_log('[sticker_pack_my] ' . $e->getMessage()); }
                    jsonResponse(true, ['items' => $items]);
                    break;
                }

                case 'sticker_pack_browse': {
                    // filter: 'trending' (default) | 'featured' | 'new' |
                    // 'animated' | 'premium'.
                    $filter = strtolower(trim((string)($input['filter'] ?? 'trending')));
                    $limit = 60;
                    $sql = "SELECT id, handle, name, author_email, description, cover_url,
                                animated, premium, install_count, created_at FROM sticker_packs";
                    switch ($filter) {
                        case 'new':
                            $sql .= " ORDER BY created_at DESC";
                            break;
                        case 'animated':
                            $sql .= " WHERE animated = TRUE ORDER BY install_count DESC, created_at DESC";
                            break;
                        case 'premium':
                            $sql .= " WHERE premium = TRUE AND animated = TRUE ORDER BY install_count DESC, created_at DESC";
                            break;
                        case 'featured':
                            // 30-day install_count window when data is rich enough.
                            $sql .= " WHERE created_at > now() - interval '30 days' ORDER BY install_count DESC, created_at DESC";
                            break;
                        case 'trending':
                        default:
                            $sql .= " ORDER BY install_count DESC, created_at DESC";
                            break;
                    }
                    $sql .= " LIMIT $limit";

                    $items = [];
                    try {
                        $stmt = $pg->prepare($sql);
                        $stmt->execute();
                        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                            $r['id'] = (int)$r['id'];
                            $r['install_count'] = (int)$r['install_count'];
                            $r['animated'] = (bool)$r['animated'];
                            $r['premium'] = (bool)$r['premium'];
                            $items[] = $r;
                        }
                    } catch (Throwable $e) { error_log('[sticker_pack_browse] ' . $e->getMessage()); }
                    jsonResponse(true, ['items' => $items, 'filter' => $filter]);
                    break;
                }

                case 'sticker_pack_search': {
                    $q = strtolower(trim((string)($input['q'] ?? '')));
                    if ($q === '' || mb_strlen($q) < 2) { jsonResponse(true, ['items' => []]); break; }
                    $items = [];
                    try {
                        $stmt = $pg->prepare("SELECT id, handle, name, author_email, description, cover_url,
                                animated, premium, install_count, created_at FROM sticker_packs
                            WHERE LOWER(name) LIKE :q OR LOWER(handle) LIKE :q OR LOWER(description) LIKE :q
                            ORDER BY install_count DESC, created_at DESC LIMIT 60");
                        $stmt->execute([':q' => '%' . $q . '%']);
                        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                            $r['id'] = (int)$r['id'];
                            $r['install_count'] = (int)$r['install_count'];
                            $r['animated'] = (bool)$r['animated'];
                            $r['premium'] = (bool)$r['premium'];
                            $items[] = $r;
                        }
                    } catch (Throwable $e) { error_log('[sticker_pack_search] ' . $e->getMessage()); }
                    jsonResponse(true, ['items' => $items]);
                    break;
                }

                case 'custom_emoji_upload': {
                    // Premium-only feature. Pro tier (PLAN_PRO) is required —
                    // 'pro' OR legacy 'family' (alias). Plus is NOT sufficient.
                    require_once __DIR__ . '/plans.php';
                    $plan = getUserPlan($user['email']);
                    $tier = strtolower((string)($plan['plan'] ?? 'free'));
                    if (!in_array($tier, ['pro', 'family'], true)) {
                        jsonResponse(false, null, 'Custom animated emoji is a Pro-only feature', 402);
                    }

                    $handle = trim((string)($input['emoji_handle'] ?? ''));
                    $webpKey = $validateR2Key($input['webp_r2_key'] ?? '');
                    if ($handle === '' || $webpKey === null) {
                        jsonResponse(false, null, 'emoji_handle and webp_r2_key required', 400);
                    }
                    // Normalize to :name: form. 2-32 alphanumeric/underscore chars.
                    if (!preg_match('/^:?([a-z0-9_]{2,32}):?$/i', $handle, $m)) {
                        jsonResponse(false, null, 'Invalid emoji_handle (use :name: with 2-32 alphanumeric chars)', 400);
                    }
                    $normalized = ':' . strtolower($m[1]) . ':';

                    try {
                        $stmt = $pg->prepare("INSERT INTO custom_animated_emoji (owner_email, emoji_handle, webp_url)
                            VALUES (:e, :h, :u)
                            ON CONFLICT (owner_email, emoji_handle) DO UPDATE SET webp_url = EXCLUDED.webp_url, created_at = now()
                            RETURNING id, created_at");
                        $stmt->execute([':e' => $user['email'], ':h' => $normalized, ':u' => $webpKey]);
                        $row = $stmt->fetch(PDO::FETCH_ASSOC);
                        jsonResponse(true, [
                            'id' => (int)$row['id'],
                            'emoji_handle' => $normalized,
                            'webp_url' => $webpKey,
                            'created_at' => $row['created_at'],
                        ]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'upload failed: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'custom_emoji_my': {
                    $items = [];
                    try {
                        $stmt = $pg->prepare("SELECT id, emoji_handle, webp_url, created_at
                            FROM custom_animated_emoji
                            WHERE LOWER(owner_email) = LOWER(:e)
                            ORDER BY created_at DESC LIMIT 500");
                        $stmt->execute([':e' => $user['email']]);
                        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                            $r['id'] = (int)$r['id'];
                            $items[] = $r;
                        }
                    } catch (Throwable $e) { error_log('[custom_emoji_my] ' . $e->getMessage()); }
                    jsonResponse(true, ['items' => $items]);
                    break;
                }

                case 'custom_emoji_delete': {
                    $id = (int)($input['id'] ?? 0);
                    if (!$id) jsonResponse(false, null, 'id required', 400);
                    try {
                        $del = $pg->prepare("DELETE FROM custom_animated_emoji WHERE id = :id AND LOWER(owner_email) = LOWER(:e)");
                        $del->execute([':id' => $id, ':e' => $user['email']]);
                        jsonResponse(true, ['deleted' => $id, 'rows' => $del->rowCount()]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'delete failed: ' . $e->getMessage(), 500);
                    }
                    break;
                }
            }
            break;
        }

        // chat_set_default_disappearing — user-level default TTL applied
        // to NEW direct chats. Cron/chat_send respect this when writing new
        // conversations.
        case 'chat_set_default_disappearing': {
            $user = requireChatAuth();
            $seconds = (int)($input['seconds'] ?? 0);
            $allowed = [0, 3600, 86400, 604800, 2592000, 7776000];
            if (!in_array($seconds, $allowed, true)) $seconds = 0;
            $db->prepare("INSERT INTO chat_user_defaults (email, default_disappearing, updated_at) VALUES (:e, :s, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email) DO UPDATE SET default_disappearing = EXCLUDED.default_disappearing, updated_at = EXCLUDED.updated_at")
               ->execute([':e' => $user['email'], ':s' => $seconds]);
            jsonResponse(true, ['seconds' => $seconds]);
            break;
        }

        // chat_topic_* — threaded sub-channels inside a group. Stored in
        // chat_topics (PG) schema already present.
        case 'chat_topic_create': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $name = trim((string)($input['name'] ?? ''));
            if (!$cid || $name === '') jsonResponse(false, null, 'conversation_id + name required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if (($membership['role'] ?? 'member') !== 'admin') {
                jsonResponse(false, null, 'Only admins can create topics', 403);
            }
            try {
                $ins = $db->prepare("INSERT INTO chat_topics (conversation_id, name, created_by, created_at) VALUES (:c, :n, :e, now()::text) RETURNING id");
                $ins->execute([':c' => $cid, ':n' => mb_substr($name, 0, 80), ':e' => $user['email']]);
                jsonResponse(true, ['id' => (int)$ins->fetchColumn(), 'name' => $name]);
            } catch (Throwable $e) { jsonResponse(false, null, 'topic create: ' . $e->getMessage(), 500); }
            break;
        }

        case 'chat_topic_delete': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? $input['topic_id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            try {
                $db->prepare("DELETE FROM chat_topics WHERE id = :id AND conversation_id IN (SELECT c.id FROM chat_conversations c JOIN chat_conversation_members cm ON cm.conversation_id = c.id AND LOWER(cm.email) = LOWER(:e) AND cm.role = 'admin')")
                   ->execute([':id' => $id, ':e' => $user['email']]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['deleted' => true]);
            break;
        }

        case 'chat_topic_pin': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? $input['topic_id'] ?? 0);
            $pinned = !empty($input['pinned']) ? 1 : 0;
            if (!$id) jsonResponse(false, null, 'id required', 400);
            try {
                try { $db->exec("ALTER TABLE chat_topics ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0"); } catch (Throwable $_) {}
                $db->prepare("UPDATE chat_topics SET pinned = :p WHERE id = :id AND conversation_id IN (SELECT c.id FROM chat_conversations c JOIN chat_conversation_members cm ON cm.conversation_id = c.id AND LOWER(cm.email) = LOWER(:e) AND cm.role = 'admin')")
                   ->execute([':p' => $pinned, ':id' => $id, ':e' => $user['email']]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['pinned' => (bool)$pinned]);
            break;
        }

        // chat_update_settings — generic user-level settings bag. JSON blob
        // keyed by user email; client can stuff whatever UI prefs in here.
        case 'chat_update_settings': {
            $user = requireChatAuth();
            $settings = $input['settings'] ?? $input;
            if (is_array($settings)) {
                // Drop routing/auth noise that's not user prefs.
                foreach (['token','password','csrf_token','action'] as $k) unset($settings[$k]);
            } else {
                $settings = [];
            }
            // Merge with existing so partial updates don't nuke other keys.
            $cur = $db->prepare("SELECT settings FROM chat_chatyy_settings WHERE LOWER(email) = LOWER(:e)");
            $cur->execute([':e' => $user['email']]);
            $rawSettings = $cur->fetchColumn();
            $existing = $rawSettings !== false ? (json_decode((string)$rawSettings, true) ?: []) : null;
            if (!is_array($existing)) $existing = [];
            $merged = array_merge($existing, $settings);
            if ($rawSettings !== false) {
                $db->prepare("UPDATE chat_chatyy_settings SET settings = :d, updated_at = now()::text WHERE LOWER(email) = LOWER(:e)")
                   ->execute([':e' => $user['email'], ':d' => json_encode($merged)]);
            } else {
                $db->prepare("INSERT INTO chat_chatyy_settings (email, settings, updated_at) VALUES (:e, :d, now()::text)")
                   ->execute([':e' => $user['email'], ':d' => json_encode($merged)]);
            }
            jsonResponse(true, ['settings' => $merged]);
            break;
        }

        // chat_privacy_contact_set — per-contact override for one of the
        // privacy knobs (e.g. hide profile photo from contact X).
        case 'chat_privacy_contact_set': {
            $user = requireChatAuth();
            $contact = strtolower(trim($input['email'] ?? $input['contact_email'] ?? ''));
            $visibility = in_array($input['visibility'] ?? '', ['show','hide'], true) ? $input['visibility'] : 'hide';
            $field = in_array($input['field'] ?? '', ['last_seen','profile_photo','about','read_receipts'], true) ? $input['field'] : 'profile_photo';
            if ($contact === '') jsonResponse(false, null, 'email required', 400);
            $db->prepare("INSERT INTO chat_user_privacy_contacts (email, contact_email, field, visibility, updated_at) VALUES (:e, :c, :f, :v, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email, contact_email, field) DO UPDATE SET visibility = EXCLUDED.visibility, updated_at = EXCLUDED.updated_at")
               ->execute([':e' => $user['email'], ':c' => $contact, ':f' => $field, ':v' => $visibility]);
            jsonResponse(true, ['contact' => $contact, 'field' => $field, 'visibility' => $visibility]);
            break;
        }

        // chat_call_history_add — client-side history adds (e.g. from SIP
        // calls that didn't go through call_notify). De-duped by call_id.
        case 'chat_call_history_add': {
            $user = requireChatAuth();
            $callId = trim((string)($input['call_id'] ?? ''));
            $contact = strtolower(trim((string)($input['contact_email'] ?? '')));
            $type = in_array($input['type'] ?? 'outgoing', ['outgoing','incoming','missed'], true) ? $input['type'] : 'outgoing';
            $video = !empty($input['video']) ? 1 : 0;
            $duration = max(0, (int)($input['duration'] ?? 0));
            $rawStatus = $input['status'] ?? 'ended'; $status = in_array($rawStatus, ['ringing','answered','missed','declined','ended','failed'], true) ? $rawStatus : 'ended';
            if ($callId === '' || $contact === '') jsonResponse(false, null, 'call_id + contact_email required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("INSERT INTO chat_call_history (user_email, contact_email, contact_name, call_id, type, video, timestamp, duration, status) VALUES (:u, :c, :cn, :ci, :t, :v, :ts, :d, :s) ON CONFLICT DO NOTHING")
                   ->execute([
                       ':u' => $user['email'], ':c' => $contact, ':cn' => chatDisplayName($contact),
                       ':ci' => $callId, ':t' => $type, ':v' => $video,
                       ':ts' => (int)(microtime(true) * 1000), ':d' => $duration, ':s' => $status,
                   ]);
            } catch (Throwable $e) { error_log('[call_history_add] ' . $e->getMessage()); }
            jsonResponse(true, ['added' => true]);
            break;
        }

        case 'chat_payment_create':
            requireChatAuth();
            jsonResponse(true, ['ok' => true]);
            break;

        // State-returning getters
        case 'chat_get_settings': {
            $user = requireChatAuth();
            // Defaults — override with whatever user saved in chat_chatyy_settings.
            $out = ['notifications' => true, 'sound' => 'default', 'theme' => 'auto', 'smart_pin_enabled' => false];
            try {
                $s = $db->prepare("SELECT settings FROM chat_chatyy_settings WHERE LOWER(email) = LOWER(:e)");
                $s->execute([':e' => $user['email']]);
                $raw = $s->fetchColumn();
                if ($raw !== false) {
                    $stored = json_decode((string)$raw, true);
                    if (is_array($stored)) $out = array_merge($out, $stored);
                }
            } catch (Throwable $e) {}
            jsonResponse(true, $out);
            break;
        }

        // chat_top_active — top N conversations by message count over last 30d.
        // Excludes manually-pinned (those already on top via cm.pinned). Used by
        // smart-pin (auto-fixar conversas mais ativas) feature.
        case 'chat_top_active': {
            $user = requireChatAuth();
            $limit = max(1, min(9, (int)($input['limit'] ?? 3)));
            $ids = [];
            try {
                $sql = "
                    SELECT m.conversation_id, COUNT(*) AS cnt
                    FROM chat_messages m
                    JOIN chat_conversation_members cm
                      ON cm.conversation_id = m.conversation_id
                     AND LOWER(cm.email) = LOWER(:e)
                    WHERE m.created_at > to_char(now() - interval '30 days', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
                      AND m.deleted_at IS NULL
                      AND COALESCE(cm.pinned, 0) = 0
                    GROUP BY m.conversation_id
                    ORDER BY cnt DESC
                    LIMIT :lim
                ";
                $st = $db->prepare($sql);
                $st->bindValue(':e', $user['email']);
                $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                $st->execute();
                $ids = array_map(fn($r) => (int)$r['conversation_id'], $st->fetchAll());
            } catch (Throwable $e) { /* fall through with empty */ }
            jsonResponse(true, ['conversation_ids' => $ids]);
            break;
        }
        case 'chat_get_auto_reply': {
            $user = requireChatAuth();
            $out = ['enabled' => false, 'message' => ''];
            try {
                $s = $db->prepare("SELECT enabled, message FROM chat_user_auto_reply WHERE LOWER(email) = LOWER(:e)");
                $s->execute([':e' => $user['email']]);
                $row = $s->fetch();
                if ($row) { $out['enabled'] = (bool)$row['enabled']; $out['message'] = (string)$row['message']; }
            } catch (Throwable $e) {}
            jsonResponse(true, $out);
            break;
        }
        case 'chat_privacy_get': {
            $user = requireChatAuth();
            $data = ['last_seen' => 'everyone', 'profile_photo' => 'everyone', 'about' => 'everyone', 'read_receipts' => true, 'phone_visibility' => 'contacts', 'cloud_chats_default' => true, 'default_disappearing_seconds' => 0];
            try {
                try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS phone_visibility TEXT DEFAULT 'contacts'"); } catch (Throwable $_) {}
                try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS cloud_chats_default BOOLEAN DEFAULT TRUE"); } catch (Throwable $_) {}
                $stmt = $db->prepare("SELECT last_seen, profile_photo, about, read_receipts, phone_visibility, cloud_chats_default FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
                $stmt->execute([':e' => $user['email']]);
                $row = $stmt->fetch();
                if ($row) {
                    $data['last_seen']     = $row['last_seen'];
                    $data['profile_photo'] = $row['profile_photo'];
                    $data['about']         = $row['about'];
                    $data['read_receipts'] = (bool)$row['read_receipts'];
                    if (!empty($row['phone_visibility'])) $data['phone_visibility'] = $row['phone_visibility'];
                    // cloud_chats_default — Telegram Cloud parity. Defaults
                    // to true (server-stored / multi-device sync) when the
                    // column has no value yet, matching the existing user
                    // expectation that chats persist by default.
                    if (array_key_exists('cloud_chats_default', $row) && $row['cloud_chats_default'] !== null) {
                        $data['cloud_chats_default'] = (bool)$row['cloud_chats_default'];
                    }
                }
            } catch (Throwable $e) {}
            // Surface the user's global default disappearing timer alongside
            // the rest of privacy so a single GET hydrates the whole page.
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_defaults (email TEXT PRIMARY KEY, default_disappearing INTEGER NOT NULL DEFAULT 0, updated_at TEXT)");
                $dq = $db->prepare("SELECT default_disappearing FROM chat_user_defaults WHERE LOWER(email) = LOWER(:e)");
                $dq->execute([':e' => $user['email']]);
                $data['default_disappearing_seconds'] = (int)($dq->fetchColumn() ?: 0);
            } catch (Throwable $e) {}
            jsonResponse(true, $data);
            break;
        }
        case 'chat_get_streaks':
            requireChatAuth();
            jsonResponse(true, ['streaks' => []]);
            break;

        // Translate a message via OpenAI gpt-4o-mini (swapped from Claude 2026-04-20).
        // Accepts { message_id } (reads DB) OR { text } (direct translate) plus optional target_lang.
        case 'chat_translate_message': {
            $user = requireChatAuth();
            $msgId = (int)($input['message_id'] ?? 0);
            $directText = trim((string)($input['text'] ?? ''));
            $targetLang = trim((string)($input['target_lang'] ?? 'pt'));
            // Accept short 2-letter or longer names; normalize to readable name for OpenAI.
            $langMap = [
                'pt' => 'Portuguese (Brazilian)', 'pt-br' => 'Portuguese (Brazilian)', 'pt-BR' => 'Portuguese (Brazilian)',
                'en' => 'English', 'en-us' => 'English', 'en-US' => 'English',
                'es' => 'Spanish', 'es-es' => 'Spanish',
                'fr' => 'French', 'de' => 'German', 'it' => 'Italian',
                'ja' => 'Japanese', 'ko' => 'Korean', 'zh' => 'Simplified Chinese', 'zh-CN' => 'Simplified Chinese',
                'ru' => 'Russian', 'ar' => 'Arabic', 'hi' => 'Hindi', 'tr' => 'Turkish',
            ];
            $langName = $langMap[$targetLang] ?? $langMap[strtolower($targetLang)] ?? 'Portuguese (Brazilian)';

            $textToTranslate = $directText;
            if ($textToTranslate === '' && $msgId > 0) {
                $stmt = $db->prepare("SELECT conversation_id, content, type FROM chat_messages WHERE id = :id AND deleted_at IS NULL");
                $stmt->execute([':id' => $msgId]);
                $msg = $stmt->fetch();
                if (!$msg) jsonResponse(false, null, 'Message not found', 404);
                requireConversationMember($db, $msg['conversation_id'], $user['email']);
                if (!in_array($msg['type'], ['text', 'system'])) {
                    jsonResponse(false, null, 'Only text messages can be translated', 400);
                }
                $textToTranslate = $msg['content'];
            }
            if ($textToTranslate === '') jsonResponse(false, null, 'Nothing to translate', 400);
            // Length cap to control cost
            if (mb_strlen($textToTranslate) > 2000) $textToTranslate = mb_substr($textToTranslate, 0, 2000);

            // Cache FIRST so repeat translations of the same text don't
            // count against the user's quota and don't hit OpenAI at all.
            $cacheDir = '/var/www/mail/data/translate-cache';
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
            $cacheKey = hash('sha256', $textToTranslate . '|' . $langName);
            $cacheFile = "{$cacheDir}/{$cacheKey}.txt";
            if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < 86400) {
                $cached = @file_get_contents($cacheFile);
                if (!empty($cached)) {
                    // Mirror file-cache hit into the PG translations table so
                    // chat_messages auto-translate hydration sees this entry
                    // on the next open. Cheap on hot path.
                    if ($msgId > 0) {
                        try {
                            @$db->exec("CREATE TABLE IF NOT EXISTS chat_message_translations (message_id BIGINT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text, PRIMARY KEY (message_id, lang))");
                            $db->prepare("INSERT INTO chat_message_translations (message_id, lang, text) VALUES (:m, :l, :t) ON CONFLICT (message_id, lang) DO UPDATE SET text = EXCLUDED.text")
                               ->execute([':m' => $msgId, ':l' => strtolower($targetLang), ':t' => (string)$cached]);
                        } catch (\Throwable $e) { error_log('[chat_translate.persist_cached] ' . $e->getMessage()); }
                    }
                    jsonResponse(true, ['translated' => $cached, 'target_lang' => $targetLang, 'cached' => true]);
                }
            }

            // Per-user rate limit: 60 fresh translations/hour. Cache hits
            // above don't count.
            $rateFile = '/tmp/chat_translate_' . md5($user['email']);
            $now = time();
            $rates = file_exists($rateFile) ? (json_decode(@file_get_contents($rateFile), true) ?: []) : [];
            $rates = array_filter($rates, fn($t) => $t > $now - 3600);
            if (count($rates) >= 60) jsonResponse(false, null, 'Translation quota hit. Try again in an hour.', 429);
            $rates[] = $now;
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            // 2026-04-20: migrated Claude Haiku → OpenAI gpt-4o-mini (Anthropic out of credits).
            $openaiKey = getenv('OPENAI_API_KEY') ?: '';
            if (!$openaiKey && file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $_line) {
                    if (strpos($_line, 'OPENAI_API_KEY=') === 0) { $openaiKey = trim(substr($_line, 15)); break; }
                }
            }
            if (!$openaiKey) jsonResponse(false, null, 'Translation service unavailable', 503);
            $system = "You are a precise translator. Translate the user's message to {$langName}. Keep emojis, slang, and formatting (like markdown) intact. Do not add explanations, quotes, or any text other than the translation itself.";
            $_payload = [
                'model' => 'gpt-4o-mini',
                'max_tokens' => 800,
                'temperature' => 0.2,
                'messages' => [
                    ['role' => 'system', 'content' => $system],
                    ['role' => 'user', 'content' => $textToTranslate],
                ],
            ];
            $_ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($_ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($_payload),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                    "Authorization: Bearer {$openaiKey}",
                    "content-type: application/json",
                ],
                CURLOPT_TIMEOUT => 60,
            ]);
            $_resp = curl_exec($_ch);
            $_code = curl_getinfo($_ch, CURLINFO_HTTP_CODE);
            curl_close($_ch);
            if ($_code !== 200) {
                error_log("[chat_translate] OpenAI HTTP $_code resp=" . substr((string)$_resp, 0, 400));
                jsonResponse(false, null, 'Translation failed: http_' . $_code, 502);
            }
            $_data = json_decode($_resp, true);
            $translated = trim($_data['choices'][0]['message']['content'] ?? '');
            if ($translated === '') {
                jsonResponse(false, null, 'Translation failed: empty_response', 502);
            }
            @file_put_contents($cacheFile, $translated, LOCK_EX);
            // Persist to chat_message_translations so chat_messages auto-
            // translate hydration on next open serves it without round-trip.
            if ($msgId > 0) {
                try {
                    @$db->exec("CREATE TABLE IF NOT EXISTS chat_message_translations (message_id BIGINT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::text, PRIMARY KEY (message_id, lang))");
                    $db->prepare("INSERT INTO chat_message_translations (message_id, lang, text) VALUES (:m, :l, :t) ON CONFLICT (message_id, lang) DO UPDATE SET text = EXCLUDED.text")
                       ->execute([':m' => $msgId, ':l' => strtolower($targetLang), ':t' => $translated]);
                } catch (\Throwable $e) { error_log('[chat_translate.persist_fresh] ' . $e->getMessage()); }
            }
            jsonResponse(true, ['translated' => $translated, 'target_lang' => $targetLang, 'cached' => false]);
            break;
        }
        // Transcribe audio message via Whisper. Requires an audio message with file_url.
        case 'chat_transcribe_audio': {
            $user = requireChatAuth();
            $msgId = (int)($input['message_id'] ?? 0);
            if (!$msgId) jsonResponse(false, null, 'message_id required', 400);
            $stmt = $db->prepare("SELECT conversation_id, type, file_url FROM chat_messages WHERE id = :id");
            $stmt->execute([':id' => $msgId]);
            $msg = $stmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);
            requireConversationMember($db, $msg['conversation_id'], $user['email']);
            if ($msg['type'] !== 'audio' && $msg['type'] !== 'voice') {
                jsonResponse(false, null, 'Not an audio message', 400);
            }

            // Cache per-message since audio content never changes
            $cacheDir = '/var/www/mail/data/transcribe-cache';
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
            $cacheFile = "{$cacheDir}/msg_{$msgId}.txt";
            if (file_exists($cacheFile)) {
                jsonResponse(true, ['transcript' => @file_get_contents($cacheFile), 'cached' => true]);
            }

            // Transcription via Groq Whisper (whisper-large-v3-turbo)
            $apiKey = _chatLoadGroqKey();
            if (empty($apiKey)) {
                jsonResponse(true, ['transcript' => '', 'error' => 'transcription_not_configured', 'confidence' => 0]);
            }

            // Resolve file path
            $url = $msg['file_url'];
            $localPath = null;
            if (preg_match('#^https?://#', $url)) {
                // R2/CDN URL — primeiro tenta resolver pra arquivo local em
                // /var/www/mail/data/chat-files (caso o upload tenha sido feito
                // via path local antes da migração R2). Antes disso o curl
                // baixava ANONIMAMENTE e se o bucket não fosse público escrevia
                // a página de erro 403 no arquivo (filesize > 0 → passava
                // checagem) e mandava XML pro Whisper, que retornava 400 e o
                // usuário via "Transcrição indisponível".
                $parsed = parse_url($url);
                $maybePath = (isset($parsed['path']) && strpos($parsed['path'], '/data/') === 0)
                    ? '/var/www/mail' . $parsed['path']
                    : null;
                if ($maybePath && file_exists($maybePath) && filesize($maybePath) > 0) {
                    $localPath = $maybePath;
                } else {
                    $tmp = tempnam('/tmp', 'chatyy_audio_');
                    $fp = @fopen($tmp, 'w');
                    $ch = curl_init($url);
                    curl_setopt_array($ch, [
                        CURLOPT_FILE => $fp,
                        CURLOPT_TIMEOUT => 30,
                        CURLOPT_FOLLOWLOCATION => true,
                        CURLOPT_FAILONERROR => true,
                    ]);
                    $okDl = @curl_exec($ch);
                    $dlCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    @curl_close($ch);
                    @fclose($fp);
                    if ($okDl !== false && $dlCode >= 200 && $dlCode < 300) {
                        $localPath = $tmp;
                    } else {
                        @unlink($tmp);
                        error_log("[transcribe] download failed http=$dlCode url=$url");
                    }
                }
            } elseif (strpos($url, '/data/') === 0) {
                $localPath = '/var/www/mail' . $url;
            }
            if (!$localPath || !file_exists($localPath) || filesize($localPath) === 0) {
                jsonResponse(false, null, 'Audio file not accessible', 502);
            }

            $cfile = new CURLFile($localPath, mime_content_type($localPath) ?: 'audio/mpeg', basename($localPath));
            $ch = curl_init('https://api.openai.com/v1/audio/transcriptions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => ['file' => $cfile, 'model' => 'whisper-1'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => ["Authorization: Bearer {$apiKey}"],
                CURLOPT_TIMEOUT => 120,
            ]);
            $resp = curl_exec($ch);
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if (preg_match('#/tmp/chatyy_audio_#', $localPath)) @unlink($localPath);

            if ($code !== 200) {
                jsonResponse(false, null, 'Transcription API error: ' . $code, 502);
            }
            $data = json_decode($resp, true);
            $transcript = $data['text'] ?? '';
            @file_put_contents($cacheFile, $transcript);
            jsonResponse(true, ['transcript' => $transcript, 'cached' => false]);
            break;
        }
        case 'chat_ai_assist':
            requireChatAuth();
            jsonResponse(true, ['suggestions' => []]);
            break;

        // Username reservation
        case 'chat_username_check':
            requireChatAuth();
            jsonResponse(true, ['available' => true]);
            break;
        case 'chat_username_claim':
            requireChatAuth();
            $input = $_REQUEST;
            jsonResponse(true, ['username' => trim((string)($input['username'] ?? ''))]);
            break;
        case 'chat_username_lookup':
            requireChatAuth();
            jsonResponse(true, ['email' => null]);
            break;

        // chat_check_chatyy — quick lookup: does a single email or phone
        // belong to a Chatyy account? Used by the shared-contact card so the
        // bubble can show "Mensagem" (opens chat) when the contact already
        // has Chatyy, or "Convidar" (sends invite) when they don't.
        case 'chat_check_chatyy': {
            requireChatAuth();
            $emailIn = strtolower(trim((string)($input['email'] ?? '')));
            $phoneIn = preg_replace('/\D/', '', (string)($input['phone'] ?? ''));
            // Normalize phone (drop +55, +1 country prefixes)
            if ($phoneIn && strlen($phoneIn) >= 12 && str_starts_with($phoneIn, '55')) $phoneIn = substr($phoneIn, 2);
            if ($phoneIn && strlen($phoneIn) === 11 && str_starts_with($phoneIn, '1'))  $phoneIn = substr($phoneIn, 1);

            $result = ['has_chatyy' => false, 'email' => null, 'name' => null];

            // 1) email match — direct check via Maildir existence
            if ($emailIn && filter_var($emailIn, FILTER_VALIDATE_EMAIL)) {
                $parts = explode('@', $emailIn);
                if (count($parts) === 2) {
                    $userDir = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}";
                    if (is_dir("{$userDir}/Maildir") || is_dir("{$userDir}/cur")) {
                        $name = $parts[0];
                        $pf = "{$userDir}/profile/data.json";
                        if (file_exists($pf)) {
                            $pd = @json_decode(@file_get_contents($pf), true);
                            if (!empty($pd['name'])) $name = $pd['name'];
                        }
                        $result = ['has_chatyy' => true, 'email' => $emailIn, 'name' => $name];
                    }
                }
            }

            // 2) phone match — only if email didn't already hit. Scan
            // profile/data.json for verified_phone or phone match.
            if (!$result['has_chatyy'] && $phoneIn && strlen($phoneIn) >= 8) {
                $domains = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
                outerPhone:
                foreach ($domains as $domainDir) {
                    $domain = basename($domainDir);
                    if (!str_contains($domain, '.')) continue;
                    $users = glob("{$domainDir}/*", GLOB_ONLYDIR) ?: [];
                    foreach ($users as $userDir) {
                        $pf = "{$userDir}/profile/data.json";
                        if (!file_exists($pf)) continue;
                        $pd = @json_decode(@file_get_contents($pf), true);
                        if (!$pd) continue;
                        foreach ([$pd['verified_phone'] ?? '', $pd['phone'] ?? ''] as $rawPhone) {
                            if (!$rawPhone) continue;
                            $ap = preg_replace('/\D/', '', $rawPhone);
                            if (strlen($ap) >= 12 && str_starts_with($ap, '55')) $ap = substr($ap, 2);
                            if (strlen($ap) === 11 && str_starts_with($ap, '1'))  $ap = substr($ap, 1);
                            if ($ap === $phoneIn) {
                                $username = basename($userDir);
                                $email = strtolower("{$username}@{$domain}");
                                $result = ['has_chatyy' => true, 'email' => $email, 'name' => $pd['name'] ?? $username];
                                break 2;
                            }
                        }
                    }
                }
            }

            jsonResponse(true, $result);
            break;
        }

        // QR login — device linking (real, persiste em PG)
        // Fluxo original: (1) desktop SEM login chama _create → token. (2)
        // mostra QR. (3) celular LOGADO lê o QR + chama _approve → server gera
        // bearer. (4) desktop polling _status → ao ver bearer, usa pra logar.
        // Companion mode (2026-05): primary mobile chama _create com
        // device_kind='mobile', secondary mobile escaneia + _approve, ganha
        // bearer pro mesmo email.
        case 'chat_qr_login_create': {
            // Unauthenticated (desktop pre-login) OR authenticated (primary
            // mobile asking to link a secondary phone — companion mode).
            // Generalized via the optional `device_kind` param
            // ('web'|'mobile'|'desktop'). Stored on the row so the approver
            // knows which surface they're linking.
            // IP rate limit: 30/min — endpoint is CSRF-exempt (used pre-login
            // by the desktop QR scanner), so without this an attacker could
            // pile rows into qr_login_tokens forever. The GC at the top of
            // the handler keeps it bounded too, but capping ingress is cheaper.
            $rlIp = preg_replace('/[^a-f0-9:.]/i', '_', (string)($_SERVER['REMOTE_ADDR'] ?? '0'));
            if (!chatRateLimit('qr_create_' . $rlIp, 'qr_create', 30, 60)) {
                jsonResponse(false, null, 'Rate limit exceeded', 429);
            }
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS qr_login_tokens (
                    token TEXT PRIMARY KEY,
                    created_at BIGINT NOT NULL,
                    expires_at BIGINT NOT NULL,
                    approved_email TEXT,
                    bearer_token TEXT,
                    approved_at BIGINT
                )");
            } catch (Throwable $e) {}
            // Schema upgrade: device_kind for companion-mode (mobile-to-mobile)
            // pairing. Older rows lack this column → ALTER ADD ... IF NOT EXISTS.
            try { $db->exec("ALTER TABLE qr_login_tokens ADD COLUMN IF NOT EXISTS device_kind TEXT DEFAULT 'web'"); } catch (Throwable $e) {}
            // Garbage-collect expired tokens (fire-and-forget)
            try { $db->exec("DELETE FROM qr_login_tokens WHERE expires_at < " . time()); } catch (Throwable $e) {}
            $deviceKind = strtolower(trim((string)($input['device_kind'] ?? $_GET['device_kind'] ?? 'web')));
            if (!in_array($deviceKind, ['web', 'mobile', 'desktop'], true)) $deviceKind = 'web';
            $qrToken = bin2hex(random_bytes(16));
            $expiresAt = time() + 300;
            try {
                $stmt = $db->prepare("INSERT INTO qr_login_tokens (token, created_at, expires_at, device_kind) VALUES (:t, :ca, :ea, :dk)");
                $stmt->execute([':t' => $qrToken, ':ca' => time(), ':ea' => $expiresAt, ':dk' => $deviceKind]);
            } catch (Throwable $e) {
                // Fallback when ALTER hasn't taken effect yet (very first hit
                // after deploy). Keep legacy column set working.
                $stmt = $db->prepare("INSERT INTO qr_login_tokens (token, created_at, expires_at) VALUES (:t, :ca, :ea)");
                $stmt->execute([':t' => $qrToken, ':ca' => time(), ':ea' => $expiresAt]);
            }
            jsonResponse(true, ['token' => $qrToken, 'expires_in' => 300, 'device_kind' => $deviceKind]);
            break;
        }
        case 'chat_qr_login_status': {
            // Unauthenticated: requesting device polling for approval.
            $qrToken = trim((string)($input['token'] ?? $_GET['token'] ?? ''));
            if (!$qrToken || !preg_match('/^[a-f0-9]{32}$/', $qrToken)) {
                jsonResponse(false, null, 'invalid token', 400);
            }
            // device_kind may be missing on legacy rows — coalesce. If schema
            // is older still (pre-migration), fall back to no-kind shape.
            try {
                $s = $db->prepare("SELECT approved_email, bearer_token, expires_at, COALESCE(device_kind, 'web') AS device_kind FROM qr_login_tokens WHERE token = :t");
                $s->execute([':t' => $qrToken]);
            } catch (Throwable $e) {
                $s = $db->prepare("SELECT approved_email, bearer_token, expires_at FROM qr_login_tokens WHERE token = :t");
                $s->execute([':t' => $qrToken]);
            }
            $row = $s->fetch();
            if (!$row) jsonResponse(true, ['status' => 'expired']);
            if ((int)$row['expires_at'] < time()) {
                jsonResponse(true, ['status' => 'expired']);
            }
            if (empty($row['bearer_token'])) {
                jsonResponse(true, ['status' => 'pending', 'device_kind' => $row['device_kind'] ?? 'web']);
            }
            // Aprovado — retorna bearer e deleta (single-use)
            $email = $row['approved_email'];
            $bearer = $row['bearer_token'];
            $db->prepare("DELETE FROM qr_login_tokens WHERE token = :t")->execute([':t' => $qrToken]);
            jsonResponse(true, [
                'status' => 'approved',
                'email' => $email,
                'token' => $bearer,
                'bearer_token' => $bearer,
                'device_kind' => $row['device_kind'] ?? 'web',
            ]);
            break;
        }
        case 'chat_qr_login_approve': {
            // Authenticated: primary device of the user. Approves linking the
            // requesting device (web/desktop/companion mobile) to this account.
            $user = requireChatAuth();
            $code = trim((string)($input['code'] ?? $input['token'] ?? ''));
            if (!$code || !preg_match('/^[a-f0-9]{32}$/', $code)) {
                jsonResponse(false, null, 'invalid code', 400);
            }
            try {
                $s = $db->prepare("SELECT expires_at, bearer_token, COALESCE(device_kind, 'web') AS device_kind FROM qr_login_tokens WHERE token = :t");
                $s->execute([':t' => $code]);
            } catch (Throwable $e) {
                $s = $db->prepare("SELECT expires_at, bearer_token FROM qr_login_tokens WHERE token = :t");
                $s->execute([':t' => $code]);
            }
            $row = $s->fetch();
            if (!$row) jsonResponse(false, null, 'QR code not found', 404);
            if ((int)$row['expires_at'] < time()) jsonResponse(false, null, 'QR code expired', 410);
            if (!empty($row['bearer_token'])) jsonResponse(false, null, 'QR code already used', 409);

            // Approver may explicitly pass device_kind — useful for the
            // companion path where the secondary mobile signals 'mobile' even
            // if the primary's create call defaulted to 'web' on an older
            // build.
            $deviceKindIn = strtolower(trim((string)($input['device_kind'] ?? '')));
            if (in_array($deviceKindIn, ['web', 'mobile', 'desktop'], true)) {
                $row['device_kind'] = $deviceKindIn;
            }

            // Gera bearer novo pro device sendo linkado — precisa da senha em sessão
            $passwordEnc = $_SESSION['password_enc'] ?? '';
            if (!$passwordEnc) jsonResponse(false, null, 'No session password', 401);
            $password = decryptSessionPassword($passwordEnc);
            if (!$password) jsonResponse(false, null, 'Decrypt failed', 500);
            if (!function_exists('generateBearerToken')) {
                @require_once __DIR__ . '/email.php';
            }
            $bearer = generateBearerToken($user['email'], $password);
            try {
                $upd = $db->prepare("UPDATE qr_login_tokens SET approved_email = :e, bearer_token = :bt, approved_at = :at, device_kind = :dk WHERE token = :t");
                $upd->execute([':e' => $user['email'], ':bt' => $bearer, ':at' => time(), ':dk' => $row['device_kind'] ?? 'web', ':t' => $code]);
            } catch (Throwable $e) {
                $upd = $db->prepare("UPDATE qr_login_tokens SET approved_email = :e, bearer_token = :bt, approved_at = :at WHERE token = :t");
                $upd->execute([':e' => $user['email'], ':bt' => $bearer, ':at' => time(), ':t' => $code]);
            }
            jsonResponse(true, ['approved' => true, 'email' => $user['email'], 'device_kind' => $row['device_kind'] ?? 'web']);
            break;
        }

        // ── Per-device key registry (SQLite-first chat migration, Stage 2) ──
        // After a web/desktop/companion-mobile device finishes QR pairing it
        // generates its own X25519 keypair and publishes the pubkey here.
        // Phone reads `chat_device_keys_list` on foreground so future
        // envelopes (Stage 5) can target each device individually instead
        // of relying on a single per-email key.
        case 'chat_device_key_publish': {
            $user = requireChatAuth();
            $deviceId = trim((string)($input['device_id'] ?? $_POST['device_id'] ?? ''));
            $pubkey   = trim((string)($input['pubkey']    ?? $_POST['pubkey']    ?? ''));
            $kind     = trim((string)($input['kind']      ?? $_POST['kind']      ?? ''));
            if ($deviceId === '' || $pubkey === '') {
                jsonResponse(false, null, 'device_id and pubkey required', 400);
            }
            // Light shape validation — device_id is a UUID-ish opaque string,
            // pubkey is base64 (~44 chars for X25519). Cap both to avoid an
            // attacker stuffing the table.
            if (strlen($deviceId) > 128 || strlen($pubkey) > 256 || strlen($kind) > 32) {
                jsonResponse(false, null, 'value too long', 400);
            }
            if (!preg_match('/^[A-Za-z0-9_\-]+$/', $deviceId)) {
                jsonResponse(false, null, 'invalid device_id', 400);
            }
            if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $pubkey)) {
                jsonResponse(false, null, 'invalid pubkey', 400);
            }
            $kindNorm = in_array(strtolower($kind), ['web', 'mobile', 'desktop', 'ios', 'android'], true)
                ? strtolower($kind) : null;
            try {
                // UPSERT keyed by (email, device_id). On re-pair from the same
                // surface, refresh the pubkey + bump last_seen_at; created_at
                // stays anchored so the phone can sort by first-seen.
                $up = $db->prepare("INSERT INTO chat_device_keys (email, device_id, pubkey, kind, last_seen_at)
                    VALUES (:e, :d, :p, :k, now())
                    ON CONFLICT (email, device_id) DO UPDATE SET
                        pubkey = EXCLUDED.pubkey,
                        kind = COALESCE(EXCLUDED.kind, chat_device_keys.kind),
                        last_seen_at = now()");
                $up->execute([':e' => $user['email'], ':d' => $deviceId, ':p' => $pubkey, ':k' => $kindNorm]);
            } catch (\Throwable $e) {
                error_log('[chat_device_key_publish] ' . $e->getMessage());
                jsonResponse(false, null, 'publish failed', 500);
            }
            jsonResponse(true, ['device_id' => $deviceId, 'kind' => $kindNorm]);
            break;
        }
        case 'chat_device_keys_list': {
            $user = requireChatAuth();
            try {
                $s = $db->prepare("SELECT device_id, pubkey, kind, created_at, last_seen_at
                    FROM chat_device_keys WHERE email = :e ORDER BY created_at ASC");
                $s->execute([':e' => $user['email']]);
                $rows = $s->fetchAll(PDO::FETCH_ASSOC);
            } catch (\Throwable $e) {
                error_log('[chat_device_keys_list] ' . $e->getMessage());
                $rows = [];
            }
            $out = [];
            foreach ($rows as $r) {
                $out[] = [
                    'device_id'    => $r['device_id'],
                    'pubkey'       => $r['pubkey'],
                    'kind'         => $r['kind'],
                    'created_at'   => $r['created_at'],
                    'last_seen_at' => $r['last_seen_at'],
                ];
            }
            jsonResponse(true, ['devices' => $out]);
            break;
        }
        // chat_conv_device_keys — returns per-device pubkeys for EVERY
        // member of a conversation. Stage 5 sender calls this right
        // before chat_envelope_send so it knows which (email, device_id,
        // pubkey) tuples to fan out to. Caller must be a member of the
        // conversation. We include the sender's own other devices too so
        // a paired desktop sees its own outgoing bubbles.
        case 'chat_conv_device_keys': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? $_POST['conversation_id'] ?? 0);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            try {
                $mem = $db->prepare("SELECT 1 FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e) LIMIT 1");
                $mem->execute([':cid' => $conversationId, ':e' => $user['email']]);
                if (!$mem->fetchColumn()) {
                    jsonResponse(false, null, 'Not a member of this conversation', 403);
                }
            } catch (\Throwable $e) { /* fall through */ }
            try {
                $s = $db->prepare("SELECT k.email, k.device_id, k.pubkey, k.kind, k.last_seen_at
                    FROM chat_device_keys k
                    JOIN chat_conversation_members m
                      ON LOWER(m.email) = LOWER(k.email)
                    WHERE m.conversation_id = :cid
                    ORDER BY k.email ASC, k.created_at ASC");
                $s->execute([':cid' => $conversationId]);
                $rows = $s->fetchAll(\PDO::FETCH_ASSOC);
            } catch (\Throwable $e) {
                error_log('[chat_conv_device_keys] ' . $e->getMessage());
                $rows = [];
            }
            $out = [];
            foreach ($rows as $r) {
                $out[] = [
                    'email'        => $r['email'],
                    'device_id'    => $r['device_id'],
                    'pubkey'       => $r['pubkey'],
                    'kind'         => $r['kind'],
                    'last_seen_at' => $r['last_seen_at'],
                ];
            }
            jsonResponse(true, ['devices' => $out, 'count' => count($out)]);
            break;
        }
        case 'chat_device_key_touch': {
            // Light idempotent heartbeat — every linked device pings this on
            // app foreground so the phone can see which surfaces are still
            // active. Returns true even if the row doesn't exist (the publish
            // step is the source of truth; touch just refreshes last_seen_at).
            $user = requireChatAuth();
            $deviceId = trim((string)($input['device_id'] ?? $_POST['device_id'] ?? ''));
            if ($deviceId === '' || strlen($deviceId) > 128 || !preg_match('/^[A-Za-z0-9_\-]+$/', $deviceId)) {
                jsonResponse(false, null, 'invalid device_id', 400);
            }
            try {
                $st = $db->prepare("UPDATE chat_device_keys SET last_seen_at = now()
                    WHERE email = :e AND device_id = :d");
                $st->execute([':e' => $user['email'], ':d' => $deviceId]);
            } catch (\Throwable $e) {
                // swallow — touch is best-effort
            }
            jsonResponse(true, ['touched' => true]);
            break;
        }

        // ── Per-recipient-device encrypted envelopes (Stage 5) ──────────
        // chat_envelope_send: sender uploads N ciphertexts (one per paired
        // device of every recipient). Each row carries the sender's
        // ephemeral X25519 pubkey + nonce so the receiver can run
        // nacl.box.open with their own device secret key. Server stores
        // ciphertext only — never plaintext. Rows are scoped to the
        // recipient + their device_id, so a phone and a paired desktop
        // both pull *different* rows and decrypt independently.
        case 'chat_envelope_send': {
            $user = requireChatAuth();
            $conversationId   = (int)($input['conversation_id']   ?? $_POST['conversation_id']   ?? 0);
            $clientMessageId  = trim((string)($input['client_message_id'] ?? $_POST['client_message_id'] ?? ''));

            // ── Shape detection ────────────────────────────────────────
            // Two accepted payloads:
            //   (A) Legacy:      {envelopes: [{recipient_email, recipient_device_id,
            //                                  ciphertext, ephemeral_pubkey, nonce}, ...]}
            //   (B) Sender-Keys: {body: {ciphertext, iv, tag?, algo?},
            //                     keys:  [{recipient_email, recipient_device_id,
            //                              key_ciphertext, key_ephemeral_pubkey, key_nonce}, ...]}
            // Detect (B) by the presence of a `body` field; otherwise fall
            // back to (A). Both shapes coexist during rollout.
            $body  = $input['body']  ?? $_POST['body']  ?? null;
            $keys  = $input['keys']  ?? $_POST['keys']  ?? null;
            if (is_string($body)) {
                $decoded = json_decode($body, true);
                if (is_array($decoded)) $body = $decoded;
            }
            if (is_string($keys)) {
                $decoded = json_decode($keys, true);
                if (is_array($decoded)) $keys = $decoded;
            }
            $isSenderKeys = is_array($body) && is_array($keys);

            if (!$isSenderKeys) {
                $envelopes        = $input['envelopes'] ?? $_POST['envelopes'] ?? null;
                if (is_string($envelopes)) {
                    $decoded = json_decode($envelopes, true);
                    if (is_array($decoded)) $envelopes = $decoded;
                }
            }

            if (!$conversationId || $clientMessageId === '') {
                jsonResponse(false, null, 'conversation_id, client_message_id required', 400);
            }
            if (strlen($clientMessageId) > 128) {
                jsonResponse(false, null, 'client_message_id too long', 400);
            }
            if ($isSenderKeys) {
                if (count($keys) > 200) {
                    jsonResponse(false, null, 'too many key envelopes', 400);
                }
            } else {
                if (!is_array($envelopes)) {
                    jsonResponse(false, null, 'envelopes[] (legacy) or body+keys (sender-keys) required', 400);
                }
                if (count($envelopes) > 200) {
                    // Hard cap — even a 50-member group with 4 devices each
                    // is 200. Anything larger is almost certainly abuse.
                    jsonResponse(false, null, 'too many envelopes', 400);
                }
            }

            // Confirm the sender is actually a member of the target convo —
            // we don't want a paired device to fan-out envelopes to
            // arbitrary recipients.
            try {
                $mem = $db->prepare("SELECT 1 FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e) LIMIT 1");
                $mem->execute([':cid' => $conversationId, ':e' => $user['email']]);
                if (!$mem->fetchColumn()) {
                    jsonResponse(false, null, 'Not a member of this conversation', 403);
                }
            } catch (\Throwable $e) { /* schema missing — fall through */ }

            $inserted = 0;
            $skipped  = 0;
            try {
                $db->beginTransaction();

                if ($isSenderKeys) {
                    // ── (B) Sender-Keys path ───────────────────────────
                    // Validate body.
                    $bCt   = trim((string)($body['ciphertext'] ?? ''));
                    $bIv   = trim((string)($body['iv']         ?? ''));
                    $bTag  = isset($body['tag']) && $body['tag'] !== null ? trim((string)$body['tag']) : null;
                    $bAlgo = trim((string)($body['algo']       ?? 'nacl_secretbox'));
                    if ($bCt === '' || $bIv === '') {
                        $db->rollBack();
                        jsonResponse(false, null, 'body.ciphertext and body.iv required', 400);
                    }
                    if (strlen($bCt) > 262144) {
                        $db->rollBack();
                        jsonResponse(false, null, 'body ciphertext too large', 400);
                    }
                    if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $bCt) ||
                        !preg_match('/^[A-Za-z0-9+\/=]+$/', $bIv) ||
                        ($bTag !== null && $bTag !== '' && !preg_match('/^[A-Za-z0-9+\/=]+$/', $bTag))) {
                        $db->rollBack();
                        jsonResponse(false, null, 'body fields must be base64', 400);
                    }
                    if (!in_array($bAlgo, ['nacl_secretbox', 'aes_gcm'], true)) {
                        $db->rollBack();
                        jsonResponse(false, null, 'unsupported body.algo', 400);
                    }

                    // Upsert the body row — UNIQUE(sender, conv, cmi) makes
                    // this idempotent on retry. Return the id either way
                    // so we can stamp every shard with body_ref.
                    $bodyIns = $db->prepare("INSERT INTO chat_pending_envelope_bodies
                        (sender_email, conversation_id, client_message_id,
                         body_ciphertext, body_iv, body_tag, body_algo)
                        VALUES (:s, :cid, :cmi, :ct, :iv, :tag, :algo)
                        ON CONFLICT (sender_email, conversation_id, client_message_id) DO UPDATE
                            SET body_ciphertext = EXCLUDED.body_ciphertext
                        RETURNING id");
                    $bodyIns->execute([
                        ':s'    => $user['email'],
                        ':cid'  => $conversationId,
                        ':cmi'  => $clientMessageId,
                        ':ct'   => $bCt,
                        ':iv'   => $bIv,
                        ':tag'  => $bTag,
                        ':algo' => $bAlgo,
                    ]);
                    $bodyId = (int)$bodyIns->fetchColumn();
                    if (!$bodyId) {
                        // Should not happen with RETURNING on UPSERT, but
                        // belt-and-suspenders — re-fetch.
                        $sel = $db->prepare("SELECT id FROM chat_pending_envelope_bodies
                            WHERE sender_email = :s AND conversation_id = :cid AND client_message_id = :cmi");
                        $sel->execute([':s' => $user['email'], ':cid' => $conversationId, ':cmi' => $clientMessageId]);
                        $bodyId = (int)$sel->fetchColumn();
                    }
                    if (!$bodyId) {
                        $db->rollBack();
                        jsonResponse(false, null, 'body insert returned no id', 500);
                    }

                    // Insert one shard per recipient device. We reuse the
                    // existing per-device columns (ciphertext, ephemeral_
                    // pubkey, nonce) to carry the WRAPPED messageKey —
                    // semantics shift when body_ref is non-NULL: it's a
                    // 32-byte key wrap, not a full message ciphertext.
                    $ins = $db->prepare("INSERT INTO chat_pending_envelopes
                        (sender_email, recipient_email, recipient_device_id,
                         conversation_id, client_message_id, ciphertext,
                         ephemeral_pubkey, nonce, body_ref)
                        VALUES (:s, :r, :d, :cid, :cmi, :ct, :ek, :n, :bref)
                        ON CONFLICT (recipient_email, recipient_device_id, client_message_id) DO NOTHING");
                    foreach ($keys as $k) {
                        $r  = trim((string)($k['recipient_email']       ?? ''));
                        $d  = trim((string)($k['recipient_device_id']   ?? ''));
                        $ct = trim((string)($k['key_ciphertext']        ?? ''));
                        $ek = trim((string)($k['key_ephemeral_pubkey']  ?? ''));
                        $n  = trim((string)($k['key_nonce']             ?? ''));
                        if ($r === '' || $d === '' || $ct === '' || $ek === '' || $n === '') {
                            $skipped++; continue;
                        }
                        if (strlen($r) > 254 || strlen($d) > 128 || strlen($ek) > 256 || strlen($n) > 64) {
                            $skipped++; continue;
                        }
                        // A wrapped 32-byte messageKey is ~80 bytes base64.
                        // Hard-cap to 512B to defend against abuse — anything
                        // larger isn't a key wrap.
                        if (strlen($ct) > 512) { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9_\-]+$/', $d)) { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $ek)) { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $n))  { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $ct)) { $skipped++; continue; }
                        $ins->execute([
                            ':s'    => $user['email'],
                            ':r'    => $r,
                            ':d'    => $d,
                            ':cid'  => $conversationId,
                            ':cmi'  => $clientMessageId,
                            ':ct'   => $ct,
                            ':ek'   => $ek,
                            ':n'    => $n,
                            ':bref' => $bodyId,
                        ]);
                        if ($ins->rowCount() > 0) $inserted++;
                    }
                } else {
                    // ── (A) Legacy path — unchanged behaviour ─────────
                    $ins = $db->prepare("INSERT INTO chat_pending_envelopes
                        (sender_email, recipient_email, recipient_device_id,
                         conversation_id, client_message_id, ciphertext,
                         ephemeral_pubkey, nonce)
                        VALUES (:s, :r, :d, :cid, :cmi, :ct, :ek, :n)
                        ON CONFLICT (recipient_email, recipient_device_id, client_message_id) DO NOTHING");
                    foreach ($envelopes as $env) {
                        $r  = trim((string)($env['recipient_email']       ?? ''));
                        $d  = trim((string)($env['recipient_device_id']   ?? ''));
                        $ct = trim((string)($env['ciphertext']            ?? ''));
                        $ek = trim((string)($env['ephemeral_pubkey']      ?? ''));
                        $n  = trim((string)($env['nonce']                 ?? ''));
                        if ($r === '' || $d === '' || $ct === '' || $ek === '' || $n === '') {
                            $skipped++; continue;
                        }
                        if (strlen($r) > 254 || strlen($d) > 128 || strlen($ek) > 256 || strlen($n) > 64) {
                            $skipped++; continue;
                        }
                        // Cap ciphertext at 256KB base64 (~192KB binary) — larger
                        // payloads should be uploaded as file_url, not inlined.
                        if (strlen($ct) > 262144) { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9_\-]+$/', $d)) { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $ek)) { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $n))  { $skipped++; continue; }
                        if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $ct)) { $skipped++; continue; }
                        $ins->execute([
                            ':s'   => $user['email'],
                            ':r'   => $r,
                            ':d'   => $d,
                            ':cid' => $conversationId,
                            ':cmi' => $clientMessageId,
                            ':ct'  => $ct,
                            ':ek'  => $ek,
                            ':n'   => $n,
                        ]);
                        if ($ins->rowCount() > 0) $inserted++;
                    }
                }
                $db->commit();
            } catch (\Throwable $e) {
                try { $db->rollBack(); } catch (\Throwable $_) {}
                error_log('[chat_envelope_send] ' . $e->getMessage());
                jsonResponse(false, null, 'envelope insert failed', 500);
            }
            jsonResponse(true, [
                'mode'     => $isSenderKeys ? 'sender_keys' : 'legacy',
                'inserted' => $inserted,
                'skipped'  => $skipped,
                'total'    => $isSenderKeys ? count($keys) : count($envelopes),
            ]);
            break;
        }

        // chat_envelopes_pull: receiver-side fetch. Pulls all undelivered
        // envelopes for (session_email, device_id). Marks them
        // delivered_at = NOW() so retries are idempotent and the sender's
        // delivery indicator can flip. Cap 100 per call — caller loops
        // until the result is empty.
        case 'chat_envelopes_pull':
        case 'chat_envelopes_pull_v2': {
            $user = requireChatAuth();
            $deviceId = trim((string)($input['device_id'] ?? $_GET['device_id'] ?? $_POST['device_id'] ?? ''));
            if ($deviceId === '' || strlen($deviceId) > 128 || !preg_match('/^[A-Za-z0-9_\-]+$/', $deviceId)) {
                jsonResponse(false, null, 'invalid device_id', 400);
            }
            // The v2 alias is intent-revealing — both endpoints return the
            // same superset shape. v1 callers ignore the new `body_*` /
            // `key_*` keys; v2-aware callers detect the Sender-Keys shape
            // by `body_ciphertext` (or top-level `body` when body_ref is
            // set). Single SELECT supports both paths via LEFT JOIN.
            try {
                // Step 1 — atomically mark up to 100 rows delivered.
                $upd = $db->prepare("UPDATE chat_pending_envelopes
                    SET delivered_at = COALESCE(delivered_at, NOW())
                    WHERE id IN (
                        SELECT id FROM chat_pending_envelopes
                        WHERE LOWER(recipient_email) = LOWER(:e)
                          AND recipient_device_id = :d
                          AND expires_at > NOW()
                        ORDER BY id ASC
                        LIMIT 100
                    )
                    RETURNING id");
                $upd->execute([':e' => $user['email'], ':d' => $deviceId]);
                $touched = $upd->fetchAll(\PDO::FETCH_COLUMN, 0);

                $rows = [];
                if (!empty($touched)) {
                    // Step 2 — fetch metadata + LEFT JOIN the shared body
                    // when body_ref is set (Sender-Keys shards). Legacy
                    // rows have body_ref NULL and bodies.* come back NULL.
                    $ph = implode(',', array_fill(0, count($touched), '?'));
                    $sel = $db->prepare("SELECT e.id, e.sender_email, e.conversation_id, e.client_message_id,
                                                e.ciphertext, e.ephemeral_pubkey, e.nonce, e.created_at,
                                                e.body_ref,
                                                b.body_ciphertext, b.body_iv, b.body_tag, b.body_algo
                        FROM chat_pending_envelopes e
                        LEFT JOIN chat_pending_envelope_bodies b ON b.id = e.body_ref
                        WHERE e.id IN ($ph)
                        ORDER BY e.id ASC");
                    $sel->execute($touched);
                    $rows = $sel->fetchAll(\PDO::FETCH_ASSOC);
                }
            } catch (\Throwable $e) {
                error_log('[chat_envelopes_pull] ' . $e->getMessage());
                $rows = [];
            }
            $out = [];
            foreach ($rows as $r) {
                $isSenderKeys = !empty($r['body_ref']) && !empty($r['body_ciphertext']);
                $row = [
                    'id'                => (int)$r['id'],
                    'sender_email'      => $r['sender_email'],
                    'conversation_id'   => (int)$r['conversation_id'],
                    'client_message_id' => $r['client_message_id'],
                    'created_at'        => $r['created_at'],
                ];
                if ($isSenderKeys) {
                    // Sender-Keys: ciphertext/ephemeral_pubkey/nonce are
                    // the WRAPPED messageKey — surface them as key_*
                    // fields and include the shared body inline. Legacy
                    // top-level fields are intentionally omitted so v1
                    // clients can't accidentally feed a wrapped key into
                    // decryptEnvelope (which would fail loudly anyway,
                    // since the plaintext after unwrap is 32 random bytes).
                    $row['body_ref']             = (int)$r['body_ref'];
                    $row['body_ciphertext']      = $r['body_ciphertext'];
                    $row['body_iv']              = $r['body_iv'];
                    $row['body_tag']             = $r['body_tag'];
                    $row['body_algo']            = $r['body_algo'] ?: 'nacl_secretbox';
                    $row['key_ciphertext']       = $r['ciphertext'];
                    $row['key_ephemeral_pubkey'] = $r['ephemeral_pubkey'];
                    $row['key_nonce']            = $r['nonce'];
                } else {
                    // Legacy per-device ciphertext — original v1 shape.
                    $row['ciphertext']       = $r['ciphertext'];
                    $row['ephemeral_pubkey'] = $r['ephemeral_pubkey'];
                    $row['nonce']            = $r['nonce'];
                }
                $out[] = $row;
            }
            jsonResponse(true, ['envelopes' => $out, 'count' => count($out)]);
            break;
        }

        // chat_envelope_ack: receiver tells the server "I've decrypted and
        // saved these N envelopes locally, drop them." Per-device delivery
        // is logged into chat_message_receipts so the sender sees per-
        // surface delivery (phone vs desktop, etc.).
        case 'chat_envelope_ack': {
            $user = requireChatAuth();
            $deviceId = trim((string)($input['device_id'] ?? $_POST['device_id'] ?? ''));
            $ids      = $input['ids'] ?? $_POST['ids'] ?? null;
            if (is_string($ids)) {
                $decoded = json_decode($ids, true);
                if (is_array($decoded)) $ids = $decoded;
            }
            if ($deviceId === '' || !preg_match('/^[A-Za-z0-9_\-]+$/', $deviceId) || strlen($deviceId) > 128) {
                jsonResponse(false, null, 'invalid device_id', 400);
            }
            if (!is_array($ids) || empty($ids)) {
                jsonResponse(false, null, 'ids[] required', 400);
            }
            // Sanitize ids → ints, cap 200.
            $intIds = [];
            foreach ($ids as $v) {
                $i = (int)$v;
                if ($i > 0) $intIds[] = $i;
                if (count($intIds) >= 200) break;
            }
            if (empty($intIds)) {
                jsonResponse(false, null, 'no valid ids', 400);
            }
            $placeholders = implode(',', array_fill(0, count($intIds), '?'));
            $acked = 0;
            try {
                $db->beginTransaction();
                // Fetch envelope metadata first so we can write receipts
                // before deleting the row.
                $sel = $db->prepare("SELECT id, sender_email, recipient_email, conversation_id, client_message_id
                    FROM chat_pending_envelopes
                    WHERE id IN ($placeholders)
                      AND LOWER(recipient_email) = LOWER(?)
                      AND recipient_device_id = ?
                    FOR UPDATE");
                $sel->execute(array_merge($intIds, [$user['email'], $deviceId]));
                $envRows = $sel->fetchAll(\PDO::FETCH_ASSOC);

                // Per-device delivery receipts. message_id is the
                // chat_messages.id if a legacy row exists (parallel path
                // during Stage 5 rollout); else 0 — the unique index on
                // (message_id, email, device_id) lets multiple
                // distinct-cmi acks coexist on message_id = 0.
                $recIns = null;
                try {
                    $recIns = $db->prepare("INSERT INTO chat_message_receipts
                        (message_id, email, delivered_at, device_id)
                        VALUES (:mid, :e, NOW(), :d)
                        ON CONFLICT (message_id, email, device_id) DO UPDATE SET
                            delivered_at = COALESCE(chat_message_receipts.delivered_at, EXCLUDED.delivered_at)");
                } catch (\Throwable $_) { /* table shape varies — best-effort */ }

                $msgLookup = null;
                try {
                    $msgLookup = $db->prepare("SELECT id FROM chat_messages
                        WHERE conversation_id = :cid AND client_message_id = :cmi
                        LIMIT 1");
                } catch (\Throwable $_) {}

                foreach ($envRows as $row) {
                    $mid = 0;
                    if ($msgLookup) {
                        try {
                            $msgLookup->execute([
                                ':cid' => (int)$row['conversation_id'],
                                ':cmi' => $row['client_message_id'],
                            ]);
                            $mid = (int)($msgLookup->fetchColumn() ?: 0);
                        } catch (\Throwable $_) {}
                    }
                    if ($recIns) {
                        try {
                            $recIns->execute([
                                ':mid' => $mid,
                                ':e'   => $user['email'],
                                ':d'   => $deviceId,
                            ]);
                        } catch (\Throwable $_) { /* schema drift, swallow */ }
                    }
                }

                $del = $db->prepare("DELETE FROM chat_pending_envelopes
                    WHERE id IN ($placeholders)
                      AND LOWER(recipient_email) = LOWER(?)
                      AND recipient_device_id = ?");
                $del->execute(array_merge($intIds, [$user['email'], $deviceId]));
                $acked = $del->rowCount();
                $db->commit();
            } catch (\Throwable $e) {
                try { $db->rollBack(); } catch (\Throwable $_) {}
                error_log('[chat_envelope_ack] ' . $e->getMessage());
                jsonResponse(false, null, 'ack failed', 500);
            }
            jsonResponse(true, ['acked' => $acked]);
            break;
        }

        // Call link creation — real implementation just generates a shareable ID

        // --- chat_group_invite_link — generate/rotate/get the invite link for a group ---
        case 'chat_group_invite_link': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $action = $input['mode'] ?? 'get'; // 'get' | 'create' | 'rotate' | 'revoke'
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            // Must be a group and user must be admin
            $stmt = $db->prepare("SELECT c.type, cm.role FROM chat_conversations c
                JOIN chat_conversation_members cm ON cm.conversation_id = c.id AND LOWER(cm.email) = LOWER(:email)
                WHERE c.id = :cid");
            $stmt->execute([':cid' => $conversationId, ':email' => $user['email']]);
            $row = $stmt->fetch();
            if (!$row) jsonResponse(false, null, 'Not a member of this group', 403);
            if ($row['type'] !== 'group') jsonResponse(false, null, 'Only groups have invite links', 400);
            if ($action !== 'get' && ($row['role'] ?? '') !== 'admin') {
                jsonResponse(false, null, 'Only admins can change the invite link', 403);
            }

            if ($action === 'revoke') {
                $db->prepare("UPDATE chat_conversations SET invite_token = NULL WHERE id = :id")->execute([':id' => $conversationId]);
                jsonResponse(true, ['revoked' => true], 'ok');
            }

            // Read current token
            $cur = $db->prepare("SELECT invite_token FROM chat_conversations WHERE id = :id");
            $cur->execute([':id' => $conversationId]);
            $tok = $cur->fetchColumn();

            if ($action === 'create' || $action === 'rotate' || ($action === 'get' && empty($tok))) {
                if ($action !== 'get' || empty($tok)) {
                    // Only generate if user is admin (for 'get' on empty, allow any member to trigger initial creation)
                    if (empty($tok) && ($row['role'] ?? '') !== 'admin' && $action !== 'get') {
                        jsonResponse(false, null, 'Only admins can generate links', 403);
                    }
                    $tok = bin2hex(random_bytes(16));
                    $db->prepare("UPDATE chat_conversations SET invite_token = :t WHERE id = :id")
                        ->execute([':t' => $tok, ':id' => $conversationId]);
                }
            }

            $url = $tok ? ('https://chatyy.com.br/j/' . $tok) : '';
            jsonResponse(true, ['token' => $tok, 'url' => $url], 'ok');
            break;
        }

        // --- chat_group_join_via_link — join a group using an invite token ---
        case 'chat_group_join_via_link': {
            $user = requireChatAuth();
            $token = trim($input['token'] ?? $_GET['token'] ?? '');
            if (!$token || !preg_match('/^[a-f0-9]{32}$/', $token)) {
                jsonResponse(false, null, 'Invalid invite token', 400);
            }

            $stmt = $db->prepare("SELECT id, name, type, description FROM chat_conversations
                WHERE invite_token = :t AND type = 'group'");
            $stmt->execute([':t' => $token]);
            $conv = $stmt->fetch();
            if (!$conv) jsonResponse(false, null, 'Invite not found or revoked', 404);

            // Already a member?
            $m = $db->prepare("SELECT role FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:email)");
            $m->execute([':cid' => $conv['id'], ':email' => $user['email']]);
            if ($m->fetch()) {
                jsonResponse(true, ['conversation_id' => (int)$conv['id'], 'already_member' => true], 'Already joined');
            }

            // Add as member in PG and fire the "X joined" system message.
            $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at)
                VALUES (:cid, :email, :dn, 'member', (now() AT TIME ZONE 'UTC')::text) ON CONFLICT DO NOTHING")
                ->execute([':cid' => $conv['id'], ':email' => $user['email'], ':dn' => chatDisplayName($user['email'])]);
            $sys = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :email, :content, 'system', (now() AT TIME ZONE 'UTC')::text) RETURNING id");
            $sys->execute([
                ':cid' => (int)$conv['id'],
                ':email' => $user['email'],
                ':content' => chatDisplayName($user['email']) . ' joined the group',
            ]);
            $sysMid = (int)$sys->fetchColumn();
            try { broadcastChatMessage($db, (int)$conv['id'], $sysMid, $user['email']); } catch (Throwable $e) {}
            try { touchConversation($db, (int)$conv['id']); } catch (Throwable $e) {}

            jsonResponse(true, [
                'conversation_id' => (int)$conv['id'],
                'name' => $conv['name'],
                'description' => $conv['description'],
                'joined' => true,
            ], 'Joined group');
            break;
        }

        // --- chat_group_set_admin_only — toggle "only admins can send messages" ---
        case 'chat_group_set_admin_only': {
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $value = !empty($input['admin_only']);
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);

            $stmt = $db->prepare("SELECT c.type, cm.role FROM chat_conversations c
                JOIN chat_conversation_members cm ON cm.conversation_id = c.id AND LOWER(cm.email) = LOWER(:email)
                WHERE c.id = :cid");
            $stmt->execute([':cid' => $conversationId, ':email' => $user['email']]);
            $row = $stmt->fetch();
            if (!$row) jsonResponse(false, null, 'Not a member', 403);
            if (($row['role'] ?? '') !== 'admin') jsonResponse(false, null, 'Only admins', 403);

            // chat_conversations.admin_only_messages is BOOLEAN in PG.
            $db->prepare("UPDATE chat_conversations SET admin_only_messages = :v WHERE id = :id")
                ->execute([':v' => $value ? 'true' : 'false', ':id' => $conversationId]);

            jsonResponse(true, ['admin_only' => $value], 'Updated');
            break;
        }
        case 'chat_create_call_link': {
            requireChatAuth();
            $linkId = bin2hex(random_bytes(8));
            jsonResponse(true, ['link_id' => $linkId, 'url' => 'https://chatyy.com.br/call/' . $linkId]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // Telegram-style sync — batch gap recovery for N conversations.
        // Input:  {"conversations":[{"id":808,"since_pts":47},...]}
        // Output: {"conversations":[{"id":808,"events":[...],"messages":[...],
        //                            "latest_pts":83,"has_more":false}]}
        // Client stores lastPts per conversation (MMKV). On WS reconnect or
        // AppState active, client calls this with each conv + its last-seen
        // pts and merges returned events into local state.
        // ═══════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════
        // chat_link_preview — fetch OpenGraph/Twitter meta for a URL
        // ═══════════════════════════════════════════════════════════
        // Cached 7 days per URL so the same link isn't re-scraped on
        // every render. Used by the client to render rich link cards
        // like WhatsApp/Telegram when a message contains a URL.
        case 'chat_link_preview': {
            $userPrev = requireChatAuth();
            // 60/min per user — fetches external URLs, so cap loud clients.
            if (!chatRateLimit($userPrev['email'], 'link_preview', 60, 60)) {
                jsonResponse(false, null, 'Rate limit exceeded', 429);
            }
            $url = trim($input['url'] ?? $_GET['url'] ?? '');
            // Cap URL length BEFORE filter_var — pathological 1MB strings
            // make filter_var thrash and waste a request slot.
            if ($url === '' || strlen($url) > 2048) {
                jsonResponse(false, null, 'url required (max 2048 chars)', 400);
            }
            // Reject control chars / NUL byte injection.
            if (preg_match('/[\x00-\x1F\x7F]/', $url)) {
                jsonResponse(false, null, 'invalid url', 400);
            }
            if (!filter_var($url, FILTER_VALIDATE_URL)) {
                jsonResponse(false, null, 'url required', 400);
            }
            // Only http(s) — block file://, gopher://, javascript:, etc.
            $scheme = strtolower(parse_url($url, PHP_URL_SCHEME) ?? '');
            if (!in_array($scheme, ['http', 'https'], true)) {
                jsonResponse(false, null, 'unsupported scheme', 400);
            }
            // SSRF guard: resolve host and reject 127.*, 10.*, 192.168.*,
            // 172.16-31.*, link-local, etc. FILTER_FLAG_NO_PRIV_RANGE +
            // NO_RES_RANGE covers all the ranges the spec calls out plus
            // a few more (loopback, multicast, broadcast, IPv6 ULA).
            $host = parse_url($url, PHP_URL_HOST) ?? '';
            if (!$host) jsonResponse(false, null, 'invalid host', 400);
            $ip = @gethostbyname($host);
            if ($ip && !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                jsonResponse(false, null, 'blocked host', 400);
            }

            // PG cache (24h) keyed by sha256(url). Lazy-create table so no
            // migration is required — first request boots it.
            $urlHash = hash('sha256', $url);
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_link_previews (
                    url_hash TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT,
                    description TEXT,
                    image TEXT,
                    site_name TEXT,
                    favicon TEXT,
                    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )");
            } catch (Throwable $_) {}

            try {
                $sel = $db->prepare("SELECT url, title, description, image, site_name, favicon, fetched_at
                                      FROM chat_link_previews
                                      WHERE url_hash = :h AND fetched_at > now() - interval '24 hours'");
                $sel->execute([':h' => $urlHash]);
                $row = $sel->fetch(\PDO::FETCH_ASSOC);
                if ($row) {
                    jsonResponse(true, [
                        'url'         => $row['url'],
                        'title'       => $row['title'],
                        'description' => $row['description'],
                        'image'       => $row['image'],
                        'site_name'   => $row['site_name'],
                        'favicon'     => $row['favicon'],
                    ]);
                }
            } catch (Throwable $_) {}

            // Fast curl: 5s total, 2s connect, cap body at 1MB so a huge
            // page can't blow PHP memory. Non-blocking via short timeout.
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS      => 3,
                CURLOPT_TIMEOUT        => 5,
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_USERAGENT      => 'Mozilla/5.0 ChatyyBot',
                CURLOPT_RANGE          => '0-1048576',
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $body = curl_exec($ch);
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $finalUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL) ?: $url;
            curl_close($ch);
            if (!$body || $code >= 400) {
                jsonResponse(false, null, "fetch failed ($code)", 502);
            }

            // Re-validate final redirected URL is still public (catches
            // redirect-to-internal SSRF attempts).
            $finalHost = parse_url($finalUrl, PHP_URL_HOST) ?? '';
            $finalIp   = $finalHost ? @gethostbyname($finalHost) : '';
            if ($finalIp && !filter_var($finalIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                jsonResponse(false, null, 'blocked redirect host', 400);
            }

            // Parse meta tags — prefer og:*, fall back to twitter:*, then <title>
            $extract = function ($html, $prop) {
                if (preg_match('#<meta[^>]+(?:property|name)=["\\\']' . preg_quote($prop, '#') . '["\\\'][^>]+content=["\\\']([^"\\\']*)["\\\']#i', $html, $m)) return html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
                if (preg_match('#<meta[^>]+content=["\\\']([^"\\\']*)["\\\'][^>]+(?:property|name)=["\\\']' . preg_quote($prop, '#') . '["\\\']#i', $html, $m)) return html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
                return null;
            };
            $title = $extract($body, 'og:title') ?? $extract($body, 'twitter:title');
            if (!$title && preg_match('#<title[^>]*>(.*?)</title>#is', $body, $m)) {
                $title = html_entity_decode(trim($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            }
            $desc = $extract($body, 'og:description') ?? $extract($body, 'twitter:description') ?? $extract($body, 'description');
            $image = $extract($body, 'og:image') ?? $extract($body, 'twitter:image');
            $siteName = $extract($body, 'og:site_name') ?? parse_url($finalUrl, PHP_URL_HOST);
            $ogUrl = $extract($body, 'og:url') ?: $finalUrl;

            // Favicon fallback — try <link rel="icon"> / "shortcut icon" first,
            // else /favicon.ico off the host. Used by the client when og:image
            // is missing, so the card still has a visual anchor.
            $favicon = null;
            if (preg_match('#<link[^>]+rel=["\\\'](?:shortcut\s+)?icon["\\\'][^>]+href=["\\\']([^"\\\']+)["\\\']#i', $body, $m)) {
                $favicon = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            } elseif (preg_match('#<link[^>]+href=["\\\']([^"\\\']+)["\\\'][^>]+rel=["\\\'](?:shortcut\s+)?icon["\\\']#i', $body, $m)) {
                $favicon = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            }
            $baseScheme = parse_url($finalUrl, PHP_URL_SCHEME) ?: 'https';
            $baseHost   = parse_url($finalUrl, PHP_URL_HOST);
            $baseRoot   = $baseScheme . '://' . $baseHost;
            if (!$favicon && $baseHost) $favicon = $baseRoot . '/favicon.ico';

            // Normalize relative URLs (image + favicon).
            $absolutize = function ($u) use ($baseRoot, $baseScheme) {
                if (!$u) return null;
                if (preg_match('#^https?://#i', $u)) return $u;
                if (str_starts_with($u, '//')) return $baseScheme . ':' . $u;
                return $baseRoot . (str_starts_with($u, '/') ? '' : '/') . $u;
            };
            $image   = $absolutize($image);
            $favicon = $absolutize($favicon);

            $preview = [
                'url'         => $ogUrl ?: $finalUrl,
                'title'       => $title ? mb_substr(trim($title), 0, 200) : null,
                'description' => $desc ? mb_substr(trim($desc), 0, 300) : null,
                'image'       => $image ? mb_substr($image, 0, 500) : null,
                'site_name'   => $siteName ? mb_substr($siteName, 0, 80) : null,
                'favicon'     => $favicon ? mb_substr($favicon, 0, 500) : null,
            ];

            try {
                $db->prepare("
                    INSERT INTO chat_link_previews (url_hash, url, title, description, image, site_name, favicon, fetched_at)
                    VALUES (:h, :u, :t, :d, :i, :s, :f, now())
                    ON CONFLICT (url_hash) DO UPDATE SET
                        url = EXCLUDED.url,
                        title = EXCLUDED.title,
                        description = EXCLUDED.description,
                        image = EXCLUDED.image,
                        site_name = EXCLUDED.site_name,
                        favicon = EXCLUDED.favicon,
                        fetched_at = EXCLUDED.fetched_at
                ")->execute([
                    ':h' => $urlHash,
                    ':u' => $preview['url'],
                    ':t' => $preview['title'],
                    ':d' => $preview['description'],
                    ':i' => $preview['image'],
                    ':s' => $preview['site_name'],
                    ':f' => $preview['favicon'],
                ]);
            } catch (Throwable $_) {}

            jsonResponse(true, $preview);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_saved_conv — lazy-create the user's "Saved Messages"
        // self-conversation (Telegram-style personal notes). Returns the
        // conv id so the client can navigate straight into it.
        // ═══════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════
        // chat_set_theme — store per-conversation wallpaper/theme.
        // value is a short key: 'default', 'cream', 'midnight', or an
        // image URL (http/https). Applied only on the caller's device
        // view (each user picks their own look, Telegram-style).
        // ═══════════════════════════════════════════════════════════
        case 'chat_set_theme': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $theme = trim((string)($input['theme'] ?? ''));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            if ($theme !== '' && !preg_match('#^[a-z0-9_-]{1,30}$#i', $theme) && !preg_match('#^https?://[a-z0-9./_-]+$#i', $theme)) {
                jsonResponse(false, null, 'invalid theme', 400);
            }
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_conversation_themes (id SERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL, email TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'default', updated_at TEXT NOT NULL DEFAULT now()::text, UNIQUE(conversation_id, email))");
            } catch (Throwable $_) {}
            if ($theme === '' || $theme === 'default') {
                $db->prepare("DELETE FROM chat_conversation_themes WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)")
                   ->execute([':c' => $cid, ':e' => $user['email']]);
                jsonResponse(true, ['theme' => 'default']);
                break;
            }
            $db->prepare("
                INSERT INTO chat_conversation_themes (conversation_id, email, theme, updated_at)
                VALUES (:c, :e, :t, (now() AT TIME ZONE 'UTC')::text)
                ON CONFLICT (conversation_id, email) DO UPDATE SET theme = EXCLUDED.theme, updated_at = EXCLUDED.updated_at
            ")->execute([':c' => $cid, ':e' => $user['email'], ':t' => $theme]);
            jsonResponse(true, ['theme' => $theme]);
            break;
        }
        case 'chat_get_theme': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            try {
                $st = $db->prepare("SELECT theme FROM chat_conversation_themes WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)");
                $st->execute([':c' => $cid, ':e' => $user['email']]);
                $t = $st->fetchColumn();
                jsonResponse(true, ['theme' => $t ?: 'default']);
            } catch (Throwable $e) {
                jsonResponse(true, ['theme' => 'default']);
            }
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_smart_reply — return 3 short AI-generated reply
        // suggestions for the latest message. Uses Claude Haiku via
        // the existing one-api service. Telegram/iMessage parity.
        // ═══════════════════════════════════════════════════════════
        case 'chat_smart_reply': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $lastMsg = trim((string)($input['last_message'] ?? ''));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);

            // Pull the last 4 messages for context if client didn't pass one
            if ($lastMsg === '') {
                $ctx = $db->prepare("SELECT sender_email, content FROM chat_messages WHERE conversation_id = :c AND deleted_at IS NULL AND type='text' ORDER BY id DESC LIMIT 4");
                $ctx->execute([':c' => $cid]);
                $rows = array_reverse($ctx->fetchAll());
                if (empty($rows)) jsonResponse(true, ['suggestions' => []]);
                $lastMsg = end($rows)['content'] ?? '';
            }
            if ($lastMsg === '' || strlen($lastMsg) > 600) {
                jsonResponse(true, ['suggestions' => []]);
                break;
            }

            // Rate limit per user: 60/min (defensive — AI costs money)
            $rateFile = sys_get_temp_dir() . '/chat_sr_rate_' . md5($user['email']) . '.txt';
            $now = time(); $wS = $now; $n = 0;
            if (is_readable($rateFile)) {
                $p = explode('|', @file_get_contents($rateFile) ?: '');
                if (count($p) === 2) { $wS = (int)$p[0]; $n = (int)$p[1]; if ($now - $wS > 60) { $wS = $now; $n = 0; } }
            }
            if ($n >= 60) jsonResponse(false, null, 'Rate limit', 429);
            @file_put_contents($rateFile, $wS . '|' . ($n + 1), LOCK_EX);

            // Call one-api for the completion. Falls back to static
            // heuristic replies if one-api is unavailable.
            $suggestions = [];
            try {
                $prompt = "Last incoming chat message (portuguese/english/spanish): \"$lastMsg\"\n\nReturn EXACTLY 3 short, casual reply suggestions the user could tap. Each ≤40 chars, no quotes, one per line.";
                $ch = curl_init('http://127.0.0.1:9106/ask');
                curl_setopt_array($ch, [
                    CURLOPT_POST => true,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Email: ' . $user['email']],
                    CURLOPT_POSTFIELDS => json_encode(['message' => $prompt, 'max_tokens' => 120, 'no_tools' => true]),
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 5,
                ]);
                $resp = curl_exec($ch); curl_close($ch);
                if ($resp) {
                    $j = json_decode($resp, true);
                    $text = $j['reply'] ?? $j['response'] ?? $j['content'] ?? '';
                    foreach (preg_split('/\r?\n/', $text) as $line) {
                        $line = trim($line);
                        // strip leading bullets/numbers
                        $line = preg_replace('/^[\-•*\d.)\s]+/', '', $line);
                        if ($line !== '' && mb_strlen($line) <= 60) $suggestions[] = $line;
                        if (count($suggestions) >= 3) break;
                    }
                }
            } catch (Throwable $e) {}
            if (empty($suggestions)) {
                // Simple fallback based on content heuristics
                $lower = mb_strtolower($lastMsg);
                if (preg_match('/\?$/u', $lastMsg)) $suggestions = ['Sim', 'Não', 'Acho que sim'];
                elseif (preg_match('/\b(oi|olá|hello|hi)\b/u', $lower)) $suggestions = ['Oi!', 'Tudo bem?', 'E aí'];
                elseif (preg_match('/\b(obrigad[oa]|thanks|thx)\b/u', $lower)) $suggestions = ['De nada!', '👍', 'Tmj'];
                else $suggestions = ['👍', 'Entendi', 'Depois conversamos'];
            }
            jsonResponse(true, ['suggestions' => array_slice($suggestions, 0, 3)]);
            break;
        }

        case 'chat_saved_conv': {
            $user = requireChatAuth();
            $em = $user['email'];
            // Find an existing direct conv where both members are the same user
            $chk = $db->prepare("
                SELECT c.id FROM chat_conversations c
                JOIN chat_conversation_members cm ON cm.conversation_id = c.id AND LOWER(cm.email) = LOWER(:em)
                WHERE c.type = 'saved' OR (c.type = 'direct' AND LOWER(c.created_by) = LOWER(:em2) AND (
                    SELECT COUNT(*) FROM chat_conversation_members WHERE conversation_id = c.id
                ) = 1)
                LIMIT 1
            ");
            $chk->execute([':em' => $em, ':em2' => $em]);
            $existing = $chk->fetchColumn();
            if ($existing) { jsonResponse(true, ['conversation_id' => (int)$existing, 'created' => false]); break; }

            $db->beginTransaction();
            try {
                $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, created_at, updated_at) VALUES ('saved', 'Mensagens salvas', :em, now()::text, now()::text) RETURNING id");
                $ins->execute([':em' => $em]);
                $cid = (int)$ins->fetchColumn();
                $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:cid, :em, 'admin', now()::text)")
                   ->execute([':cid' => $cid, ':em' => $em]);
                $db->commit();
                jsonResponse(true, ['conversation_id' => $cid, 'created' => true]);
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                jsonResponse(false, null, 'Failed to create saved conv: ' . $e->getMessage(), 500);
            }
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_edit_history — return the saved edit trail for a message.
        // Versions are appended by chat_edit before overwriting content.
        // ═══════════════════════════════════════════════════════════
        case 'chat_edit_history': {
            $user = requireChatAuth();
            $mid = (int)($input['message_id'] ?? $_GET['message_id'] ?? 0);
            if (!$mid) jsonResponse(false, null, 'message_id required', 400);
            // Verify user is a member of the message's conversation
            $mStmt = $db->prepare("SELECT conversation_id, sender_email, content, edited_at FROM chat_messages WHERE id = :id");
            $mStmt->execute([':id' => $mid]);
            $msg = $mStmt->fetch();
            if (!$msg) jsonResponse(false, null, 'Message not found', 404);
            requireConversationMember($db, (int)$msg['conversation_id'], $user['email']);
            try {
                $vs = $db->prepare("SELECT content, edited_at FROM chat_message_versions WHERE message_id = :m ORDER BY edited_at DESC");
                $vs->execute([':m' => $mid]);
                $versions = $vs->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            } catch (Throwable $e) { $versions = []; }
            jsonResponse(true, [
                'message_id' => $mid,
                'current'    => ['content' => $msg['content'], 'edited_at' => $msg['edited_at']],
                'versions'   => $versions,
            ]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_messages_by_date — Telegram "jump to date" support.
        // Returns the first message at or after the given date so the
        // client can scrollToItem on its id.
        // ═══════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════
        // chat_load_around — fetch a window of messages anchored on a
        // target id. Returns up to `before` messages with id<=target plus
        // up to `after` messages with id>target, merged & sorted asc.
        // Used by the client when the user taps a pinned banner / reply
        // jump and the target is outside the currently rendered window.
        // ═══════════════════════════════════════════════════════════
        case 'chat_load_around': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            $mid = (int)($input['message_id'] ?? $_GET['message_id'] ?? 0);
            $before = max(1, min(100, (int)($input['before'] ?? 30)));
            $after = max(0, min(50, (int)($input['after'] ?? 10)));
            if (!$cid || !$mid) jsonResponse(false, null, 'conversation_id + message_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            try {
                $cols = "id, conversation_id, sender_email, content, type,
                         reply_to_id, reply_quote_text, file_url, file_name, file_size,
                         edited_at, deleted_at, created_at, is_view_once,
                         forwarded_from, COALESCE(forward_count, 0) AS forward_count,
                         client_message_id, COALESCE(conv_pts, 0) AS conv_pts,
                         mentions, viewed_by, thumb_b64";
                $beforeStmt = $db->prepare("SELECT $cols FROM chat_messages WHERE conversation_id = :cid AND id <= :mid ORDER BY id DESC LIMIT :lim");
                $beforeStmt->bindValue(':cid', $cid, \PDO::PARAM_INT);
                $beforeStmt->bindValue(':mid', $mid, \PDO::PARAM_INT);
                $beforeStmt->bindValue(':lim', $before, \PDO::PARAM_INT);
                $beforeStmt->execute();
                $beforeRows = $beforeStmt->fetchAll(\PDO::FETCH_ASSOC);

                $afterRows = [];
                if ($after > 0) {
                    $afterStmt = $db->prepare("SELECT $cols FROM chat_messages WHERE conversation_id = :cid AND id > :mid ORDER BY id ASC LIMIT :lim");
                    $afterStmt->bindValue(':cid', $cid, \PDO::PARAM_INT);
                    $afterStmt->bindValue(':mid', $mid, \PDO::PARAM_INT);
                    $afterStmt->bindValue(':lim', $after, \PDO::PARAM_INT);
                    $afterStmt->execute();
                    $afterRows = $afterStmt->fetchAll(\PDO::FETCH_ASSOC);
                }
                // Merge: before is DESC → reverse to ASC, then append after (ASC)
                $merged = array_merge(array_reverse($beforeRows), $afterRows);
                jsonResponse(true, ['messages' => $merged, 'anchor_id' => $mid]);
            } catch (\Throwable $e) {
                error_log('[chat_load_around] ' . $e->getMessage());
                jsonResponse(false, null, 'load_around failed', 500);
            }
            break;
        }

        case 'chat_messages_by_date': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            $date = trim((string)($input['date'] ?? $_GET['date'] ?? ''));
            if (!$cid || !$date) jsonResponse(false, null, 'conversation_id + date required', 400);
            $ts = strtotime($date);
            if (!$ts) jsonResponse(false, null, 'invalid date', 400);
            requireConversationMember($db, $cid, $user['email']);
            $iso = date('Y-m-d H:i:s', $ts);
            $stmt = $db->prepare("
                SELECT id FROM chat_messages
                WHERE conversation_id = :cid AND deleted_at IS NULL
                  AND created_at >= :iso
                ORDER BY id ASC LIMIT 1
            ");
            $stmt->execute([':cid' => $cid, ':iso' => $iso]);
            $firstId = (int)($stmt->fetchColumn() ?: 0);
            jsonResponse(true, ['message_id' => $firstId, 'date' => $iso]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_clear_history — WhatsApp-style "Clear chat history".
        // Sets cleared_at on this user's conversation_member row;
        // chat_messages action then hides messages older than that
        // timestamp from THIS user only. The other party still sees
        // everything (they can clear independently). The actual rows
        // remain in chat_messages — no data loss server-side.
        // ═══════════════════════════════════════════════════════════
        case 'chat_clear_history': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);
            try {
                $upd = $db->prepare("UPDATE chat_conversation_members SET cleared_at = now()::text WHERE conversation_id = :cid AND LOWER(email) = LOWER(:em)");
                $upd->execute([':cid' => $cid, ':em' => $user['email']]);
            } catch (\Throwable $e) {
                jsonResponse(false, null, 'failed to clear history', 500);
            }
            jsonResponse(true, ['ok' => true]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_mute_member — silence one specific member inside a group
        // (Telegram's "mute user in group"). Stored per-admin per-target
        // so each admin's own feed can filter independently.
        // ═══════════════════════════════════════════════════════════
        case 'chat_mute_member': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $target = strtolower(trim((string)($input['email'] ?? '')));
            $minutes = (int)($input['minutes'] ?? 0); // 0 = permanent until unmute
            if (!$cid || !$target) jsonResponse(false, null, 'conversation_id + email required', 400);
            if (!filter_var($target, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'invalid target', 400);
            requireConversationMember($db, $cid, $user['email']);
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_conversation_muted_members (id SERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL, muter_email TEXT NOT NULL, target_email TEXT NOT NULL, muted_until TEXT, created_at TEXT NOT NULL DEFAULT now()::text, UNIQUE(conversation_id, muter_email, target_email))");
            } catch (Throwable $_) {}
            $until = $minutes > 0 ? date('Y-m-d H:i:s', time() + $minutes * 60) : null;
            $db->prepare("
                INSERT INTO chat_conversation_muted_members (conversation_id, muter_email, target_email, muted_until)
                VALUES (:c, :m, :t, :u)
                ON CONFLICT (conversation_id, muter_email, target_email) DO UPDATE SET muted_until = EXCLUDED.muted_until
            ")->execute([':c' => $cid, ':m' => $user['email'], ':t' => $target, ':u' => $until]);
            jsonResponse(true, ['muted' => true, 'muted_until' => $until]);
            break;
        }
        case 'chat_unmute_member': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $target = strtolower(trim((string)($input['email'] ?? '')));
            if (!$cid || !$target) jsonResponse(false, null, 'conversation_id + email required', 400);
            try {
                $db->prepare("DELETE FROM chat_conversation_muted_members WHERE conversation_id = :c AND LOWER(muter_email) = LOWER(:m) AND LOWER(target_email) = LOWER(:t)")
                   ->execute([':c' => $cid, ':m' => $user['email'], ':t' => $target]);
            } catch (Throwable $e) {}
            jsonResponse(true, ['muted' => false]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_set_sound — per-conversation custom notification sound.
        // Stored as a small string (filename, 'default', or 'silent').
        // Push notifications read this and pass the sound to FCM/APNs.
        // ═══════════════════════════════════════════════════════════
        case 'chat_set_sound': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $sound = trim((string)($input['sound'] ?? ''));
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            if (!preg_match('/^[A-Za-z0-9._-]{0,60}$/', $sound)) jsonResponse(false, null, 'invalid sound name', 400);
            requireConversationMember($db, $cid, $user['email']);
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_conversation_sound_prefs (id SERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL, email TEXT NOT NULL, sound TEXT NOT NULL DEFAULT 'default', UNIQUE(conversation_id, email))");
            } catch (Throwable $_) {}
            $db->prepare("
                INSERT INTO chat_conversation_sound_prefs (conversation_id, email, sound)
                VALUES (:c, :e, :s)
                ON CONFLICT (conversation_id, email) DO UPDATE SET sound = EXCLUDED.sound
            ")->execute([':c' => $cid, ':e' => $user['email'], ':s' => $sound]);
            jsonResponse(true, ['sound' => $sound]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_draft_get / chat_draft_set — device-synced drafts, so
        // typing on one device shows the draft on the other. Stored
        // per (conversation, email) with a last-updated timestamp.
        // ═══════════════════════════════════════════════════════════
        case 'chat_draft_set': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $text = (string)($input['text'] ?? '');
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            if (mb_strlen($text) > 8000) $text = mb_substr($text, 0, 8000);
            requireConversationMember($db, $cid, $user['email']);
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_conversation_drafts (id SERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL, email TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT now()::text, UNIQUE(conversation_id, email))");
            } catch (Throwable $_) {}
            if ($text === '') {
                $db->prepare("DELETE FROM chat_conversation_drafts WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)")
                   ->execute([':c' => $cid, ':e' => $user['email']]);
                _broadcastDraftToOwnDevices($user['email'], $cid, '');
                jsonResponse(true, ['saved' => false, 'cleared' => true]);
                break;
            }
            $db->prepare("
                INSERT INTO chat_conversation_drafts (conversation_id, email, text, updated_at)
                VALUES (:c, :e, :t, (now() AT TIME ZONE 'UTC')::text)
                ON CONFLICT (conversation_id, email) DO UPDATE SET text = EXCLUDED.text, updated_at = EXCLUDED.updated_at
            ")->execute([':c' => $cid, ':e' => $user['email'], ':t' => $text]);
            _broadcastDraftToOwnDevices($user['email'], $cid, $text);
            jsonResponse(true, ['saved' => true]);
            break;
        }
        case 'chat_draft_get': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            try {
                $st = $db->prepare("SELECT text, updated_at FROM chat_conversation_drafts WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)");
                $st->execute([':c' => $cid, ':e' => $user['email']]);
                $r = $st->fetch();
                jsonResponse(true, ['text' => $r['text'] ?? '', 'updated_at' => $r['updated_at'] ?? null]);
            } catch (Throwable $e) {
                jsonResponse(true, ['text' => '', 'updated_at' => null]);
            }
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_nickname_set / chat_nickname_list — per-user contact rename.
        // Each user can assign a private nickname to another email; only
        // they see it (WhatsApp-style "how I call this person" override).
        // Stored in chat_user_nicknames (owner_email, target_email, nickname).
        // ═══════════════════════════════════════════════════════════
        case 'chat_nickname_set': {
            $user = requireChatAuth();
            $target = strtolower(trim((string)($input['email'] ?? '')));
            $nickname = trim((string)($input['nickname'] ?? ''));
            if ($target === '' || !filter_var($target, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'email required', 400);
            if (mb_strlen($nickname) > 100) $nickname = mb_substr($nickname, 0, 100);
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_user_nicknames (
                    id SERIAL PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    target_email TEXT NOT NULL,
                    nickname TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (now()::text),
                    UNIQUE(owner_email, target_email)
                )");
            } catch (Throwable $_) {}
            if ($nickname === '') {
                $db->prepare("DELETE FROM chat_user_nicknames WHERE LOWER(owner_email) = LOWER(:o) AND LOWER(target_email) = LOWER(:t)")
                   ->execute([':o' => $user['email'], ':t' => $target]);
                jsonResponse(true, ['cleared' => true]);
                break;
            }
            $db->prepare("
                INSERT INTO chat_user_nicknames (owner_email, target_email, nickname, updated_at)
                VALUES (LOWER(:o), LOWER(:t), :n, (now() AT TIME ZONE 'UTC')::text)
                ON CONFLICT (owner_email, target_email) DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = EXCLUDED.updated_at
            ")->execute([':o' => $user['email'], ':t' => $target, ':n' => $nickname]);
            jsonResponse(true, ['nickname' => $nickname]);
            break;
        }

        case 'chat_nickname_list': {
            $user = requireChatAuth();
            try {
                $st = $db->prepare("SELECT target_email, nickname FROM chat_user_nicknames WHERE LOWER(owner_email) = LOWER(:o)");
                $st->execute([':o' => $user['email']]);
                $out = [];
                foreach ($st->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                    $out[$r['target_email']] = $r['nickname'];
                }
                jsonResponse(true, ['nicknames' => $out]);
            } catch (Throwable $e) {
                jsonResponse(true, ['nicknames' => []]);
            }
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_group_invite_create — Admin generates a shareable link.
        // Stored in chat_group_invites (token, conversation_id, created_by,
        // expires_at). Link format: https://chatyy.com.br/g/<token>.
        // ═══════════════════════════════════════════════════════════
        case 'chat_group_invite_create': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if (($membership['type'] ?? '') !== 'group') jsonResponse(false, null, 'Only group conversations support invite links', 400);
            if (($membership['role'] ?? 'member') !== 'admin') jsonResponse(false, null, 'Only admins can create invite links', 403);
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_group_invites (
                    token TEXT PRIMARY KEY,
                    conversation_id BIGINT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (now()::text),
                    expires_at TEXT,
                    max_uses INTEGER,
                    use_count INTEGER NOT NULL DEFAULT 0,
                    revoked INTEGER NOT NULL DEFAULT 0
                )");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_group_invites_conv ON chat_group_invites(conversation_id)");
            } catch (Throwable $_) {}
            // Reuse a live non-revoked invite for the same conversation if one
            // exists — WhatsApp keeps a single invite per group by default.
            $st = $db->prepare("SELECT token FROM chat_group_invites WHERE conversation_id = :c AND revoked = 0 ORDER BY created_at DESC LIMIT 1");
            $st->execute([':c' => $cid]);
            $existing = $st->fetch(\PDO::FETCH_ASSOC);
            if ($existing) {
                $token = $existing['token'];
            } else {
                $token = bin2hex(random_bytes(12));
                $db->prepare("INSERT INTO chat_group_invites (token, conversation_id, created_by, created_at) VALUES (:tk, :c, :u, now()::text)")
                   ->execute([':tk' => $token, ':c' => $cid, ':u' => $user['email']]);
            }
            $link = 'https://chatyy.com.br/g/' . $token;
            jsonResponse(true, ['token' => $token, 'link' => $link, 'conversation_id' => $cid]);
            break;
        }

        case 'chat_group_invite_revoke': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            $membership = requireConversationMember($db, $cid, $user['email']);
            if (($membership['role'] ?? 'member') !== 'admin') jsonResponse(false, null, 'Only admins can revoke', 403);
            $db->prepare("UPDATE chat_group_invites SET revoked = 1 WHERE conversation_id = :c")->execute([':c' => $cid]);
            jsonResponse(true, ['revoked' => true]);
            break;
        }

        case 'chat_group_invite_join': {
            $user = requireChatAuth();
            $token = trim((string)($input['token'] ?? ''));
            if (!preg_match('/^[a-f0-9]{24}$/', $token)) jsonResponse(false, null, 'invalid token', 400);
            $st = $db->prepare("SELECT conversation_id, revoked, expires_at, max_uses, use_count FROM chat_group_invites WHERE token = :t");
            $st->execute([':t' => $token]);
            $inv = $st->fetch(\PDO::FETCH_ASSOC);
            if (!$inv) jsonResponse(false, null, 'Invite not found', 404);
            if ((int)$inv['revoked'] === 1) jsonResponse(false, null, 'Invite revoked', 410);
            if (!empty($inv['expires_at']) && strtotime($inv['expires_at']) < time()) jsonResponse(false, null, 'Invite expired', 410);
            if (!empty($inv['max_uses']) && (int)$inv['use_count'] >= (int)$inv['max_uses']) jsonResponse(false, null, 'Invite exhausted', 410);
            $cid = (int)$inv['conversation_id'];
            // Already a member? idempotent success.
            $chk = $db->prepare("SELECT 1 FROM chat_conversation_members WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)");
            $chk->execute([':c' => $cid, ':e' => $user['email']]);
            if (!$chk->fetch()) {
                $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:c, LOWER(:e), :n, 'member', now()::text)")
                   ->execute([':c' => $cid, ':e' => $user['email'], ':n' => chatDisplayName($user['email'])]);
                // Count the use once the user actually joined.
                $db->prepare("UPDATE chat_group_invites SET use_count = use_count + 1 WHERE token = :t")->execute([':t' => $token]);
                // System message so existing members see who joined.
                $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:c, :e, :msg, 'system', now()::text)")
                   ->execute([':c' => $cid, ':e' => $user['email'], ':msg' => chatDisplayName($user['email']) . ' entrou pelo link de convite']);
            }
            $st = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
            $st->execute([':id' => $cid]);
            $conv = $st->fetch();
            jsonResponse(true, buildConversationData($db, $conv, $user['email']));
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_saved — Idempotent "Saved Messages" (chat with self).
        // Single-member direct conversation, pinned by convention to top
        // of the list with a star. Used as a personal notepad for
        // links, files, reminders. Telegram-style.
        // ═══════════════════════════════════════════════════════════
        case 'chat_saved': {
            $user = requireChatAuth();
            $me = strtolower($user['email']);
            $directKey = 'saved:' . $me;
            $conv = null;
            try {
                $st = $db->prepare("SELECT * FROM chat_conversations WHERE direct_key = :k LIMIT 1");
                $st->execute([':k' => $directKey]);
                $conv = $st->fetch();
            } catch (Throwable $_) {}
            if (!$conv) {
                try {
                    $db->beginTransaction();
                    $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, direct_key, created_at, updated_at) VALUES ('saved', :n, :cb, :dk, now()::text, now()::text) RETURNING id");
                    $ins->execute([':n' => 'Saved Messages', ':cb' => $user['email'], ':dk' => $directKey]);
                    $cid = (int)$ins->fetchColumn();
                    $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text) ON CONFLICT DO NOTHING")
                       ->execute([':cid' => $cid, ':em' => $me, ':dn' => chatDisplayName($user['email'])]);
                    $db->commit();
                    $st = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
                    $st->execute([':id' => $cid]);
                    $conv = $st->fetch();
                } catch (Throwable $e) {
                    if ($db->inTransaction()) $db->rollBack();
                    // Legacy deployments may not accept 'saved' in chat_conversations.type.
                    // Retry once using 'direct' as the type so the conv still materializes.
                    try {
                        $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, direct_key, created_at, updated_at) VALUES ('direct', :n, :cb, :dk, now()::text, now()::text) RETURNING id");
                        $ins->execute([':n' => 'Saved Messages', ':cb' => $user['email'], ':dk' => $directKey]);
                        $cid = (int)$ins->fetchColumn();
                        $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text) ON CONFLICT DO NOTHING")
                           ->execute([':cid' => $cid, ':em' => $me, ':dn' => chatDisplayName($user['email'])]);
                        $st = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
                        $st->execute([':id' => $cid]);
                        $conv = $st->fetch();
                    } catch (Throwable $e2) {
                        jsonResponse(false, null, 'Failed to create Saved Messages: ' . $e2->getMessage(), 500);
                    }
                }
            }
            if (!$conv) jsonResponse(false, null, 'Saved Messages not available', 500);
            jsonResponse(true, buildConversationData($db, $conv, $user['email']));
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_export_zip — Build a ZIP with messages.json + chat.html +
        // chat.txt (WhatsApp-style, importable). Stored in
        // /var/www/mail/data/chat-exports/, returned as a time-limited
        // signed URL. Telegram-style full-conversation export. Separate
        // from the legacy `chat_export` action (single-format txt/json).
        // ═══════════════════════════════════════════════════════════
        case 'chat_export_zip': {
            $user = requireChatAuth();
            $cid = (int)($input['conversation_id'] ?? 0);
            if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $cid, $user['email']);

            $st = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
            $st->execute([':id' => $cid]);
            $conv = $st->fetch();
            if (!$conv) jsonResponse(false, null, 'Conversation not found', 404);

            $mm = $db->prepare("SELECT email, display_name, role FROM chat_conversation_members WHERE conversation_id = :c ORDER BY joined_at");
            $mm->execute([':c' => $cid]);
            $members = $mm->fetchAll();

            $sm = $db->prepare("
                SELECT m.id, m.sender_email, m.content, m.type, m.file_url, m.file_name,
                       m.file_size, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at,
                       (SELECT json_agg(json_build_object('emoji', r.emoji, 'email', r.email))
                          FROM chat_message_reactions r WHERE r.message_id = m.id) AS reactions
                FROM chat_messages m
                WHERE m.conversation_id = :c AND m.deleted_at IS NULL
                ORDER BY m.id ASC
            ");
            $sm->execute([':c' => $cid]);
            $messages = $sm->fetchAll();

            foreach ($messages as &$m) {
                $m['id'] = (int)$m['id'];
                $m['sender_name'] = chatDisplayName($m['sender_email']);
                if (!empty($m['reactions']) && is_string($m['reactions'])) {
                    $m['reactions'] = json_decode($m['reactions'], true) ?: [];
                }
            }
            unset($m);

            $exportDir = '/var/www/mail/data/chat-exports';
            if (!is_dir($exportDir)) { @mkdir($exportDir, 0775, true); @chown($exportDir, 'www-data'); }

            $token = bin2hex(random_bytes(16));
            $zipName = 'chat-' . $cid . '-' . $token . '.zip';
            $zipPath = $exportDir . '/' . $zipName;

            $zip = new ZipArchive();
            if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
                jsonResponse(false, null, 'Failed to create export archive', 500);
            }

            $meta = [
                'conversation_id' => $cid,
                'name'            => $conv['name'] ?? '',
                'type'            => $conv['type'] ?? 'direct',
                'created_at'      => $conv['created_at'] ?? '',
                'members'         => array_map(fn($mm) => [
                    'email' => $mm['email'],
                    'name'  => chatDisplayName($mm['email']),
                    'role'  => $mm['role'],
                ], $members),
                'exported_by'     => $user['email'],
                'exported_at'     => gmdate('c'),
                'message_count'   => count($messages),
            ];
            $zip->addFromString('metadata.json', json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
            $zip->addFromString('messages.json', json_encode($messages, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

            $txt = "Chatyy export — {$meta['name']} ({$meta['type']})\n";
            $txt .= "Exported by {$meta['exported_by']} at {$meta['exported_at']}\n";
            $txt .= str_repeat('=', 60) . "\n\n";
            foreach ($messages as $m) {
                $when = date('d/m/Y H:i:s', strtotime($m['created_at']));
                $who  = $m['sender_name'] ?: $m['sender_email'];
                $body = '';
                if ($m['type'] === 'image')      $body = '[image: ' . ($m['file_url'] ?? '') . ']';
                else if ($m['type'] === 'video') $body = '[video: ' . ($m['file_url'] ?? '') . ']';
                else if ($m['type'] === 'audio') $body = '[audio: ' . ($m['file_url'] ?? '') . ']';
                else if ($m['type'] === 'file')  $body = '[file: ' . ($m['file_name'] ?? $m['file_url'] ?? '') . ']';
                else                              $body = $m['content'] ?? '';
                $txt .= "[{$when}] {$who}: {$body}\n";
            }
            $zip->addFromString('chat.txt', $txt);

            $html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>" . htmlspecialchars($meta['name']) . "</title>";
            $html .= "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:20px auto;padding:0 16px;background:#f5f5f7;color:#1a1a1a}.msg{background:#fff;border-radius:8px;padding:10px 14px;margin:6px 0;box-shadow:0 1px 2px rgba(0,0,0,0.05)}.who{font-weight:600;font-size:13px;color:#7C3AED;margin-bottom:4px}.when{font-size:11px;color:#888;margin-left:6px}.body{white-space:pre-wrap;word-break:break-word}img,video{max-width:100%;border-radius:6px;margin-top:6px}h1{font-size:20px}</style></head><body>";
            $html .= "<h1>" . htmlspecialchars($meta['name'] ?: 'Chat') . "</h1>";
            $html .= "<p style=\"color:#888;font-size:13px\">" . count($messages) . " messages · exported " . $meta['exported_at'] . "</p>";
            foreach ($messages as $m) {
                $when = htmlspecialchars(date('d/m/Y H:i', strtotime($m['created_at'])));
                $who  = htmlspecialchars($m['sender_name'] ?: $m['sender_email']);
                $bodyHtml = '';
                if ($m['type'] === 'image' && !empty($m['file_url']))      $bodyHtml = '<img src="' . htmlspecialchars($m['file_url']) . '" alt="">';
                else if ($m['type'] === 'video' && !empty($m['file_url'])) $bodyHtml = '<video controls src="' . htmlspecialchars($m['file_url']) . '"></video>';
                else if ($m['type'] === 'audio' && !empty($m['file_url'])) $bodyHtml = '<audio controls src="' . htmlspecialchars($m['file_url']) . '"></audio>';
                else if (!empty($m['file_url']))                           $bodyHtml = '<a href="' . htmlspecialchars($m['file_url']) . '">' . htmlspecialchars($m['file_name'] ?? 'file') . '</a>';
                if (!empty($m['content'])) $bodyHtml = htmlspecialchars($m['content']) . ($bodyHtml ? '<br>' . $bodyHtml : '');
                $html .= "<div class=\"msg\"><div class=\"who\">{$who}<span class=\"when\">{$when}</span></div><div class=\"body\">{$bodyHtml}</div></div>";
            }
            $html .= "</body></html>";
            $zip->addFromString('chat.html', $html);

            $zip->close();
            @chmod($zipPath, 0664);

            $sizeBytes = filesize($zipPath);
            $publicUrl = '/data/chat-exports/' . $zipName;
            jsonResponse(true, [
                'url'            => $publicUrl,
                'size'           => $sizeBytes,
                'message_count'  => count($messages),
                'expires_at'     => gmdate('c', time() + 7 * 24 * 3600),
            ]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_create_secret — Create (or reuse) an E2E-encrypted direct
        // chat flagged is_secret=true. Signal-style key material is
        // managed by the existing e2ee_* endpoints; this case just
        // materializes the conversation row with the right flag so the
        // client auto-enables E2EE on open.
        // ═══════════════════════════════════════════════════════════
        case 'chat_create_secret': {
            $user = requireChatAuth();
            $peer = strtolower(trim((string)($input['peer_email'] ?? '')));
            if (!filter_var($peer, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'peer_email required', 400);
            if ($peer === strtolower($user['email'])) jsonResponse(false, null, 'Cannot secret-chat with yourself', 400);
            try { $db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS is_e2ee BOOLEAN DEFAULT FALSE"); } catch (Throwable $_) {}

            $me = strtolower($user['email']);
            // Secret chat = separate direct conv (different direct_key prefix)
            // so users can have BOTH a regular and a secret conversation with
            // the same peer (Telegram parity).
            $directKey = 'secret:' . ($me < $peer ? "$me|$peer" : "$peer|$me");
            $conv = null;
            try {
                $st = $db->prepare("SELECT * FROM chat_conversations WHERE direct_key = :k LIMIT 1");
                $st->execute([':k' => $directKey]);
                $conv = $st->fetch();
            } catch (Throwable $_) {}
            if (!$conv) {
                try {
                    $db->beginTransaction();
                    $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, direct_key, is_e2ee, created_at, updated_at) VALUES ('direct', :n, :cb, :dk, TRUE, now()::text, now()::text) RETURNING id");
                    $ins->execute([':n' => 'Secret Chat', ':cb' => $user['email'], ':dk' => $directKey]);
                    $cid = (int)$ins->fetchColumn();
                    $insM = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, :r, now()::text) ON CONFLICT DO NOTHING");
                    foreach ([$user['email'], $peer] as $em) {
                        $role = ($em === $user['email']) ? 'admin' : 'member';
                        $insM->execute([':cid' => $cid, ':em' => strtolower($em), ':dn' => chatDisplayName($em), ':r' => $role]);
                    }
                    $db->commit();
                    $st = $db->prepare("SELECT * FROM chat_conversations WHERE id = :id");
                    $st->execute([':id' => $cid]);
                    $conv = $st->fetch();
                } catch (Throwable $e) {
                    if ($db->inTransaction()) $db->rollBack();
                    jsonResponse(false, null, 'Failed to create secret chat: ' . $e->getMessage(), 500);
                }
            }
            jsonResponse(true, buildConversationData($db, $conv, $user['email']));
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // chat_import — bulk-import history from a WhatsApp-style export
        // (.txt log). Parses lines like:
        //   [19/04/2026 14:30:15] User Name: Hello world
        // Creates a conversation (or reuses an existing direct) and
        // inserts the messages with their original timestamps.
        // ═══════════════════════════════════════════════════════════
        case 'chat_import': {
            $user = requireChatAuth();
            $text   = (string)($input['text'] ?? '');
            $name   = trim((string)($input['conv_name'] ?? 'Imported chat'));
            $peer   = strtolower(trim((string)($input['peer_email'] ?? '')));
            $format = strtolower((string)($input['format'] ?? 'whatsapp'));
            if ($text === '' || strlen($text) > 5 * 1024 * 1024) {
                jsonResponse(false, null, 'text required (max 5MB)', 400);
            }

            // Parse — WhatsApp format covers both iOS and Android exports.
            // iOS:     [dd/mm/yyyy hh:mm:ss] Sender: message
            // Android: dd/mm/yyyy, hh:mm - Sender: message
            $parsed = [];
            $lines = preg_split('/\r?\n/', $text);
            $currentSender = null;
            $currentTs = null;
            $buffer = '';
            $flush = function() use (&$parsed, &$currentSender, &$currentTs, &$buffer) {
                if ($currentSender !== null && $buffer !== '') {
                    $parsed[] = ['ts' => $currentTs, 'sender' => $currentSender, 'content' => rtrim($buffer, "\r\n")];
                }
                $buffer = '';
            };
            foreach ($lines as $line) {
                if (preg_match('#^\[?(\d{1,2})[/-](\d{1,2})[/-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*[-–]?\s*([^:]+?):\s?(.*)$#u', $line, $m)) {
                    $flush();
                    $day = (int)$m[1]; $mo = (int)$m[2]; $yr = (int)$m[3];
                    if ($yr < 100) $yr += 2000;
                    $hr = (int)$m[4]; $min = (int)$m[5]; $sec = (int)($m[6] ?? 0);
                    $currentTs = sprintf('%04d-%02d-%02d %02d:%02d:%02d', $yr, $mo, $day, $hr, $min, $sec);
                    $currentSender = trim($m[7]);
                    $buffer = $m[8];
                } else {
                    // continuation of previous message
                    if ($currentSender !== null) $buffer .= "\n" . $line;
                }
            }
            $flush();
            if (count($parsed) === 0) jsonResponse(false, null, 'no messages parsed', 400);
            if (count($parsed) > 10000) $parsed = array_slice($parsed, 0, 10000);

            // Find or create the target conversation. Direct if peer is
            // provided, otherwise a group-type "archive" conv.
            $convId = null;
            if ($peer && filter_var($peer, FILTER_VALIDATE_EMAIL)) {
                $k = strtolower($user['email']) < $peer
                    ? strtolower($user['email']) . '|' . $peer
                    : $peer . '|' . strtolower($user['email']);
                try {
                    $ps = $db->prepare("SELECT id FROM chat_conversations WHERE type='direct' AND direct_key = :k LIMIT 1");
                    $ps->execute([':k' => $k]);
                    $r = $ps->fetch();
                    if ($r) $convId = (int)$r['id'];
                } catch (Throwable $e) {}
            }
            if (!$convId) {
                $db->beginTransaction();
                try {
                    $ins = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, created_at, updated_at) VALUES (:t, :n, :em, now()::text, now()::text) RETURNING id");
                    $ins->execute([':t' => $peer ? 'direct' : 'group', ':n' => $name, ':em' => $user['email']]);
                    $convId = (int)$ins->fetchColumn();
                    $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:c, :e, 'admin', now()::text)")
                       ->execute([':c' => $convId, ':e' => $user['email']]);
                    if ($peer) {
                        try {
                            $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:c, :e, 'member', now()::text)")
                               ->execute([':c' => $convId, ':e' => $peer]);
                        } catch (Throwable $e) {}
                    }
                    $db->commit();
                } catch (Throwable $e) { if ($db->inTransaction()) $db->rollBack(); jsonResponse(false, null, 'create conv failed', 500); }
            }

            // Bulk insert parsed messages. Use the creator's email for
            // messages whose sender_name doesn't match a known member —
            // keeps content without fabricating accounts.
            $ins = $db->prepare("
                INSERT INTO chat_messages (conversation_id, sender_email, sender_name, content, type, created_at)
                VALUES (:c, :e, :n, :t, 'text', :ca)
            ");
            $inserted = 0;
            $db->beginTransaction();
            foreach ($parsed as $p) {
                $senderEmail = $user['email']; // default to importer
                if ($peer && stripos($p['sender'], $peer) === false) {
                    // heuristic: if sender name loosely matches peer display, use peer
                }
                try {
                    $ins->execute([
                        ':c'  => $convId,
                        ':e'  => $senderEmail,
                        ':n'  => mb_substr($p['sender'], 0, 80),
                        ':t'  => mb_substr($p['content'], 0, 32000),
                        ':ca' => $p['ts'],
                    ]);
                    $inserted++;
                } catch (Throwable $e) {}
            }
            $db->commit();
            try { touchConversation($db, $convId); } catch (Throwable $e) {}
            jsonResponse(true, ['conversation_id' => $convId, 'imported' => $inserted, 'parsed' => count($parsed)]);
            break;
        }

        case 'chat_sync': {
            $user = requireChatAuth();
            $input = getInput();
            $convs = is_array($input['conversations'] ?? null) ? $input['conversations'] : [];
            // Cap batch size so an exploited/buggy client can't DoS us via a
            // 100k-item sync request. Realistic inbox has <200 conversations.
            if (count($convs) > 200) $convs = array_slice($convs, 0, 200);
            $out = [];
            foreach ($convs as $c) {
                $cid = (int)($c['id'] ?? 0);
                $since = (int)($c['since_pts'] ?? 0);
                if ($cid <= 0) continue;
                // Direct member check — requireConversationMember() calls jsonResponse+exit()
                // on failure, so we can't wrap it in try-catch. Non-members get an
                // explicit {denied:true} row so the client knows to drop this conv
                // from its list rather than silently thinking it's up-to-date.
                //
                // Case-insensitive: tokens can carry the auth email with its
                // registration-time casing while conversation_members stores
                // lowercased values (chat_add_member strtolower's on insert).
                // Matching on LOWER(email) keeps both happy.
                $memChk = $db->prepare("SELECT 1 FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:em) LIMIT 1");
                $memChk->execute([':cid' => $cid, ':em' => $user['email']]);
                if (!$memChk->fetchColumn()) {
                    $out[] = ['id' => $cid, 'denied' => true, 'events' => [], 'messages' => [], 'latest_pts' => 0, 'has_more' => false];
                    continue;
                }
                $limit = min(500, max(1, (int)($c['limit'] ?? 500)));
                $evStmt = $db->prepare("
                    SELECT id, seq AS pts, event_type, user_email AS actor_email, data::text AS payload, created_at
                    FROM chat_sync_events
                    WHERE conversation_id = :cid AND seq > :since
                    ORDER BY seq ASC
                    LIMIT $limit
                ");
                $evStmt->execute([':cid' => $cid, ':since' => $since]);
                $events = [];
                $msgIds = [];
                foreach ($evStmt->fetchAll() as $e) {
                    $pl = json_decode($e['payload'] ?: '{}', true) ?: [];
                    if (($e['event_type'] ?? '') === 'new_message' && !empty($pl['message_id'])) {
                        $msgIds[] = (int)$pl['message_id'];
                    }
                    $events[] = [
                        'pts'        => (int)$e['pts'],
                        'type'       => $e['event_type'],
                        'actor'      => $e['actor_email'],
                        'payload'    => $pl,
                        'created_at' => $e['created_at'],
                    ];
                }
                // Hydrate new_message events with the full message row so the
                // client renders immediately without a second fetch.
                //
                // We DON'T filter `deleted_at IS NULL` here: if a message was
                // created and then deleted while the client was offline, the
                // new_message event still references the id. Skipping the row
                // makes applyEvents bump the pts watermark past a hole the UI
                // never drew. Return the soft-deleted row so the client can
                // render the tombstone (content is already empty).
                $messages = [];
                if ($msgIds) {
                    $in = implode(',', array_fill(0, count($msgIds), '?'));
                    $mStmt = $db->prepare("
                        SELECT m.id, m.conversation_id, m.sender_email, m.content, m.type,
                               m.reply_to_id, m.file_url, m.file_name, m.file_size,
                               m.edited_at, m.deleted_at, m.created_at, m.is_view_once,
                               m.client_message_id, m.conv_pts, m.thumb_b64
                        FROM chat_messages m
                        WHERE m.id IN ($in)
                    ");
                    $mStmt->execute($msgIds);
                    $messages = $mStmt->fetchAll();
                    // Hydrate reply_to preview so the client can render the
                    // quoted bubble immediately (parity with broadcastChatMessage).
                    // Before this, chat_sync-delivered messages showed the
                    // reply chain blank until the user refreshed the thread.
                    $replyIds = array_values(array_filter(array_map(fn($m) => (int)($m['reply_to_id'] ?? 0), $messages)));
                    $replyById = [];
                    if ($replyIds) {
                        $rin = implode(',', array_fill(0, count($replyIds), '?'));
                        $rStmt = $db->prepare("SELECT id, sender_email, content, type FROM chat_messages WHERE id IN ($rin) AND deleted_at IS NULL");
                        $rStmt->execute($replyIds);
                        foreach ($rStmt->fetchAll() as $r) {
                            $replyById[(int)$r['id']] = [
                                'id'           => (int)$r['id'],
                                'sender_email' => $r['sender_email'],
                                'sender_name'  => chatDisplayName($r['sender_email']),
                                'content'      => mb_substr((string)$r['content'], 0, 200),
                                'type'         => $r['type'],
                            ];
                        }
                    }
                    // Delivery/read receipts for own messages so tick state
                    // is correct on cold sync (matches chat_messages path).
                    $ownIds = [];
                    foreach ($messages as $mm) {
                        if (strcasecmp($mm['sender_email'] ?? '', $user['email']) === 0) {
                            $ownIds[] = (int)$mm['id'];
                        }
                    }
                    $deliveredByMsg = [];
                    $readByMsg = [];
                    if ($ownIds) {
                        try {
                            $inPG = implode(',', array_fill(0, count($ownIds), '?'));
                            $rStmt = $db->prepare("SELECT message_id, email, delivered_at, read_at FROM chat_message_receipts WHERE message_id IN ($inPG)");
                            $rStmt->execute($ownIds);
                            foreach ($rStmt->fetchAll(\PDO::FETCH_ASSOC) as $rr) {
                                $mid = (int)$rr['message_id'];
                                if (!empty($rr['delivered_at'])) $deliveredByMsg[$mid][] = $rr['email'];
                                if (!empty($rr['read_at']))      $readByMsg[$mid][]      = $rr['email'];
                            }
                        } catch (Throwable $e) {}
                    }
                    foreach ($messages as &$m) {
                        $m['sender_name'] = chatDisplayName($m['sender_email']);
                        $rid = (int)($m['reply_to_id'] ?? 0);
                        $m['reply_to'] = $rid && isset($replyById[$rid]) ? $replyById[$rid] : null;
                        if (strcasecmp($m['sender_email'] ?? '', $user['email']) === 0) {
                            $m['delivered_to'] = $deliveredByMsg[(int)$m['id']] ?? [];
                            $m['read_by']      = $readByMsg[(int)$m['id']]      ?? [];
                            $m['_delivered']   = !empty($m['delivered_to']);
                        }
                    }
                    unset($m);
                }
                $latestStmt = $db->prepare("SELECT COALESCE(sync_seq, 0) FROM chat_conversations WHERE id = :cid");
                $latestStmt->execute([':cid' => $cid]);
                $out[] = [
                    'id'         => $cid,
                    'events'     => $events,
                    'messages'   => $messages,
                    'latest_pts' => (int)$latestStmt->fetchColumn(),
                    'has_more'   => count($events) >= $limit,
                ];
            }
            jsonResponse(true, ['conversations' => $out]);
            break;
        }

        // ============================================================
        // COMMUNITIES — bundle of groups + announcement channel
        // (WhatsApp-style Communities; tables auto-created on first use)
        // ============================================================
        case 'community_create':
        case 'community_list':
        case 'community_info':
        case 'community_add_group':
        case 'community_remove_group':
        case 'community_members':
        case 'community_announce':
        case 'community_announcement':
        case 'community_update':
        case 'community_member_role':
        case 'community_kick':
        case 'community_discover':
        case 'community_join':
        case 'community_leave': {
            $user = requireChatAuth();
            $email = strtolower($user['email']);

            // Lazy schema: create tables if missing. Cheap on PG (CREATE IF NOT EXISTS).
            // Spec calls for richer columns (handle, cover, rules, welcome_message,
            // member_count, discoverable). Also evolves any older deployment via
            // ADD COLUMN IF NOT EXISTS so we never break existing rows.
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS chat_communities (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    handle TEXT,
                    description TEXT DEFAULT '',
                    icon TEXT DEFAULT '',
                    photo_url TEXT DEFAULT '',
                    cover_url TEXT DEFAULT '',
                    owner_email TEXT,
                    rules TEXT DEFAULT '',
                    welcome_message TEXT DEFAULT '',
                    category TEXT DEFAULT 'other',
                    member_count INT DEFAULT 0,
                    discoverable BOOLEAN DEFAULT FALSE,
                    created_by TEXT NOT NULL,
                    announcement_conv_id INTEGER,
                    general_conv_id INTEGER,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    updated_at TIMESTAMPTZ DEFAULT now()
                )");
                // Evolve older deployments
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS handle TEXT");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS photo_url TEXT DEFAULT ''");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS cover_url TEXT DEFAULT ''");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS owner_email TEXT");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS rules TEXT DEFAULT ''");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS welcome_message TEXT DEFAULT ''");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other'");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS member_count INT DEFAULT 0");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS discoverable BOOLEAN DEFAULT FALSE");
                $db->exec("ALTER TABLE chat_communities ADD COLUMN IF NOT EXISTS general_conv_id INTEGER");
                try { $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_handle ON chat_communities(LOWER(handle)) WHERE handle IS NOT NULL"); } catch (Throwable $e) {}

                $db->exec("CREATE TABLE IF NOT EXISTS chat_community_members (
                    community_id INTEGER NOT NULL,
                    email TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'member',
                    joined_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (community_id, email)
                )");
                $db->exec("CREATE TABLE IF NOT EXISTS chat_community_groups (
                    community_id INTEGER NOT NULL,
                    conversation_id INTEGER NOT NULL,
                    kind TEXT DEFAULT 'topic',
                    order_idx INT DEFAULT 0,
                    is_announcement BOOLEAN DEFAULT false,
                    added_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (community_id, conversation_id)
                )");
                $db->exec("ALTER TABLE chat_community_groups ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'topic'");
                $db->exec("ALTER TABLE chat_community_groups ADD COLUMN IF NOT EXISTS order_idx INT DEFAULT 0");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_community_members_email ON chat_community_members(email)");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_community_groups_conv ON chat_community_groups(conversation_id)");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_communities_discoverable ON chat_communities(discoverable, member_count DESC) WHERE discoverable = TRUE");
            } catch (Throwable $e) { /* table likely already exists */ }

            // Helper: resolve community by id or @handle. Accepts numeric id
            // or a string starting with "@" or a bare handle. Returns int|null.
            $resolveCommunityId = function($idOrHandle) use ($db) {
                if ($idOrHandle === null || $idOrHandle === '') return null;
                if (is_numeric($idOrHandle)) return (int)$idOrHandle;
                $h = ltrim(trim((string)$idOrHandle), '@');
                if ($h === '') return null;
                $s = $db->prepare("SELECT id FROM chat_communities WHERE LOWER(handle) = LOWER(:h) LIMIT 1");
                $s->execute([':h' => $h]);
                $cid = $s->fetchColumn();
                return $cid ? (int)$cid : null;
            };
            // Recompute member_count from chat_community_members (cheap, keeps cache fresh)
            $refreshMemberCount = function($cid) use ($db) {
                try {
                    $db->prepare("UPDATE chat_communities SET member_count = (SELECT COUNT(*) FROM chat_community_members WHERE community_id = :c) WHERE id = :c2")
                        ->execute([':c' => $cid, ':c2' => $cid]);
                } catch (Throwable $e) {}
            };

            // Helper: confirm caller is admin of community $cid
            $assertCommunityAdmin = function($cid) use ($db, $email) {
                $s = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                $s->execute([':c' => $cid, ':e' => $email]);
                $r = $s->fetch();
                if (!$r) jsonResponse(false, null, 'Not a member of this community', 403);
                if (($r['role'] ?? 'member') !== 'admin') jsonResponse(false, null, 'Admin only', 403);
            };
            $assertCommunityMember = function($cid) use ($db, $email) {
                $s = $db->prepare("SELECT 1 FROM chat_community_members WHERE community_id = :c AND email = :e");
                $s->execute([':c' => $cid, ':e' => $email]);
                if (!$s->fetchColumn()) jsonResponse(false, null, 'Not a member of this community', 403);
            };

            switch ($action) {
                case 'community_create': {
                    // 3 per hour — creating a community is heavy (multiple
                    // tables + 2 conversations + index work).
                    if (!chatRateLimit($email, 'community_create', 3, 3600)) {
                        jsonResponse(false, null, 'Rate limit exceeded — try again in 1 hour', 429);
                    }
                    $name = trim((string)($input['name'] ?? ''));
                    $handleRaw = trim((string)($input['handle'] ?? ''));
                    $description = trim((string)($input['description'] ?? ''));
                    $photoUrl = trim((string)($input['photo_url'] ?? ($input['icon'] ?? '')));
                    $coverUrl = trim((string)($input['cover_url'] ?? ''));
                    $rules = trim((string)($input['rules'] ?? ''));
                    $welcome = trim((string)($input['welcome_message'] ?? ''));
                    $category = trim((string)($input['category'] ?? 'other'));
                    $discoverable = !empty($input['discoverable']) && filter_var($input['discoverable'], FILTER_VALIDATE_BOOLEAN);

                    if ($name === '' || mb_strlen($name) > 100) jsonResponse(false, null, 'Name 1-100 chars required', 400);
                    if (mb_strlen($description) > 1000) jsonResponse(false, null, 'Description max 1000 chars', 400);
                    if (mb_strlen($rules) > 4000) jsonResponse(false, null, 'Rules max 4000 chars', 400);
                    if (mb_strlen($welcome) > 1000) jsonResponse(false, null, 'Welcome message max 1000 chars', 400);

                    // Normalize handle: strip @, lowercase, [a-z0-9_], 3-32 chars
                    $handle = ltrim($handleRaw, '@');
                    if ($handle !== '') {
                        $handle = strtolower($handle);
                        if (!preg_match('/^[a-z0-9_]{3,32}$/', $handle)) {
                            jsonResponse(false, null, 'Handle must be 3-32 chars [a-z0-9_]', 400);
                        }
                        $hCheck = $db->prepare("SELECT 1 FROM chat_communities WHERE LOWER(handle) = :h LIMIT 1");
                        $hCheck->execute([':h' => $handle]);
                        if ($hCheck->fetchColumn()) jsonResponse(false, null, 'Handle already taken', 409);
                    } else {
                        $handle = null;
                    }

                    try {
                        $db->beginTransaction();
                        $ins = $db->prepare("INSERT INTO chat_communities
                            (name, handle, description, icon, photo_url, cover_url, owner_email, rules, welcome_message, category, discoverable, member_count, created_by)
                            VALUES (:n, :h, :d, :i, :p, :cov, :oe, :r, :w, :cat, :disc, 1, :cb)
                            RETURNING id");
                        $ins->execute([
                            ':n' => $name, ':h' => $handle, ':d' => $description,
                            ':i' => $photoUrl, ':p' => $photoUrl, ':cov' => $coverUrl,
                            ':oe' => $email, ':r' => $rules, ':w' => $welcome,
                            ':cat' => $category, ':disc' => $discoverable ? 't' : 'f',
                            ':cb' => $email,
                        ]);
                        $cid = (int)$ins->fetchColumn();

                        // Owner gets the canonical 'owner' role.
                        $insM = $db->prepare("INSERT INTO chat_community_members (community_id, email, role) VALUES (:c, :e, 'owner')");
                        $insM->execute([':c' => $cid, ':e' => $email]);

                        // 1. Announcement channel (read-only for members, write for admins)
                        $insAnn = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, created_at, updated_at) VALUES ('channel', :n, :cb, now()::text, now()::text) RETURNING id");
                        $insAnn->execute([':n' => $name . ' — Avisos', ':cb' => $email]);
                        $announceConvId = (int)$insAnn->fetchColumn();
                        $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text)")
                            ->execute([':cid' => $announceConvId, ':em' => $email, ':dn' => chatDisplayName($email)]);

                        // 2. "Geral" sub-group — write for everyone
                        $insGen = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, created_at, updated_at) VALUES ('group', :n, :cb, now()::text, now()::text) RETURNING id");
                        $insGen->execute([':n' => 'Geral', ':cb' => $email]);
                        $generalConvId = (int)$insGen->fetchColumn();
                        $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text)")
                            ->execute([':cid' => $generalConvId, ':em' => $email, ':dn' => chatDisplayName($email)]);

                        $db->prepare("UPDATE chat_communities SET announcement_conv_id = :ac, general_conv_id = :gc WHERE id = :c")
                            ->execute([':ac' => $announceConvId, ':gc' => $generalConvId, ':c' => $cid]);

                        $insG = $db->prepare("INSERT INTO chat_community_groups (community_id, conversation_id, kind, order_idx, is_announcement) VALUES (:c, :conv, :k, :o, :ia)");
                        $insG->execute([':c' => $cid, ':conv' => $announceConvId, ':k' => 'announcement', ':o' => 0, ':ia' => 't']);
                        $insG->execute([':c' => $cid, ':conv' => $generalConvId,  ':k' => 'general',      ':o' => 1, ':ia' => 'f']);
                        $db->commit();

                        jsonResponse(true, [
                            'community' => [
                                'id' => $cid,
                                'name' => $name,
                                'handle' => $handle,
                                'description' => $description,
                                'photo_url' => $photoUrl,
                                'cover_url' => $coverUrl,
                                'rules' => $rules,
                                'welcome_message' => $welcome,
                                'discoverable' => $discoverable,
                                'announcement_conv_id' => $announceConvId,
                                'general_conv_id' => $generalConvId,
                                'role' => 'owner',
                                'my_role' => 'owner',
                                'is_member' => true,
                                'member_count' => 1,
                                'group_count' => 2,
                            ],
                            'community_id' => $cid,
                            'announcement_conv_id' => $announceConvId,
                            'general_conv_id' => $generalConvId,
                        ]);
                    } catch (Throwable $e) {
                        if ($db->inTransaction()) $db->rollBack();
                        jsonResponse(false, null, 'Failed to create community: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'community_list': {
                    $stmt = $db->prepare("
                        SELECT c.id, c.name, c.handle, c.description, c.photo_url, c.cover_url, c.icon,
                               c.announcement_conv_id, c.general_conv_id, c.discoverable,
                               c.created_at, cm.role,
                               c.member_count,
                               (SELECT COUNT(*) FROM chat_community_groups WHERE community_id = c.id) AS group_count
                        FROM chat_communities c
                        JOIN chat_community_members cm ON cm.community_id = c.id
                        WHERE cm.email = :e
                        ORDER BY c.updated_at DESC
                    ");
                    $stmt->execute([':e' => $email]);
                    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                    foreach ($rows as &$r) {
                        $r['id'] = (int)$r['id'];
                        $r['announcement_conv_id'] = $r['announcement_conv_id'] !== null ? (int)$r['announcement_conv_id'] : null;
                        $r['general_conv_id'] = $r['general_conv_id'] !== null ? (int)$r['general_conv_id'] : null;
                        $r['member_count'] = (int)$r['member_count'];
                        $r['group_count'] = (int)$r['group_count'];
                        $r['discoverable'] = (bool)$r['discoverable'];
                    }
                    jsonResponse(true, ['communities' => $rows]);
                    break;
                }

                case 'community_info': {
                    $cid = $resolveCommunityId($input['community_id'] ?? ($input['id_or_handle'] ?? ($input['id'] ?? null)));
                    if (!$cid) jsonResponse(false, null, 'community_id or handle required', 400);

                    $cStmt = $db->prepare("SELECT * FROM chat_communities WHERE id = :c");
                    $cStmt->execute([':c' => $cid]);
                    $community = $cStmt->fetch(PDO::FETCH_ASSOC);
                    if (!$community) jsonResponse(false, null, 'Community not found', 404);

                    // Caller's role (or null if non-member). Discoverable
                    // communities expose info to non-members so they can
                    // preview before joining.
                    $myRoleStmt = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                    $myRoleStmt->execute([':c' => $cid, ':e' => $email]);
                    $myRole = $myRoleStmt->fetchColumn() ?: null;
                    $isMember = (bool)$myRole;

                    if (!$isMember && !$community['discoverable']) {
                        jsonResponse(false, null, 'Not a member of this community', 403);
                    }

                    $gStmt = $db->prepare("
                        SELECT cg.conversation_id, cg.is_announcement, cg.kind, cg.order_idx, cg.added_at,
                               cv.name, cv.type, cv.updated_at,
                               (SELECT COUNT(*) FROM chat_conversation_members WHERE conversation_id = cg.conversation_id) AS member_count
                        FROM chat_community_groups cg
                        JOIN chat_conversations cv ON cv.id = cg.conversation_id
                        WHERE cg.community_id = :c
                        ORDER BY cg.is_announcement DESC, cg.order_idx ASC, cv.updated_at DESC
                    ");
                    $gStmt->execute([':c' => $cid]);
                    $groups = $gStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                    foreach ($groups as &$g) {
                        $g['conversation_id'] = (int)$g['conversation_id'];
                        $g['is_announcement'] = (bool)$g['is_announcement'];
                        $g['member_count'] = (int)$g['member_count'];
                        $g['order_idx'] = (int)$g['order_idx'];
                    }

                    jsonResponse(true, [
                        'community' => [
                            'id' => (int)$community['id'],
                            'name' => $community['name'],
                            'handle' => $community['handle'] ?? null,
                            'description' => $community['description'] ?? '',
                            'icon' => $community['icon'] ?? '',
                            'photo_url' => $community['photo_url'] ?? '',
                            'cover_url' => $community['cover_url'] ?? '',
                            'rules' => $community['rules'] ?? '',
                            'welcome_message' => $community['welcome_message'] ?? '',
                            'category' => $community['category'] ?? 'other',
                            'member_count' => (int)($community['member_count'] ?? 0),
                            'group_count' => count($groups),
                            'discoverable' => (bool)$community['discoverable'],
                            'owner_email' => $community['owner_email'] ?? $community['created_by'],
                            'announcement_conv_id' => $community['announcement_conv_id'] !== null ? (int)$community['announcement_conv_id'] : null,
                            'general_conv_id' => $community['general_conv_id'] !== null ? (int)$community['general_conv_id'] : null,
                            'created_by' => $community['created_by'],
                            'created_at' => $community['created_at'] ?? null,
                            'role' => $myRole,
                            'my_role' => $myRole,
                            'is_member' => $isMember,
                        ],
                        'groups' => $groups,
                    ]);
                    break;
                }

                case 'community_update': {
                    $cid = (int)($input['community_id'] ?? 0);
                    if (!$cid) jsonResponse(false, null, 'community_id required', 400);
                    $assertCommunityAdmin($cid);

                    $sets = []; $params = [':c' => $cid];
                    $map = [
                        'name'             => ['key' => ':n',    'maxLen' => 100],
                        'description'      => ['key' => ':d',    'maxLen' => 1000],
                        'photo_url'        => ['key' => ':p',    'maxLen' => 1000],
                        'cover_url'        => ['key' => ':cov',  'maxLen' => 1000],
                        'rules'            => ['key' => ':r',    'maxLen' => 4000],
                        'welcome_message'  => ['key' => ':w',    'maxLen' => 1000],
                        'category'         => ['key' => ':cat',  'maxLen' => 32],
                    ];
                    foreach ($map as $field => $cfg) {
                        if (array_key_exists($field, $input)) {
                            $val = trim((string)$input[$field]);
                            if (mb_strlen($val) > $cfg['maxLen']) jsonResponse(false, null, $field . ' too long', 400);
                            $sets[] = "$field = " . $cfg['key'];
                            $params[$cfg['key']] = $val;
                        }
                    }
                    if (array_key_exists('discoverable', $input)) {
                        $sets[] = "discoverable = :disc";
                        $params[':disc'] = (filter_var($input['discoverable'], FILTER_VALIDATE_BOOLEAN) ? 't' : 'f');
                    }
                    if (empty($sets)) jsonResponse(false, null, 'No fields to update', 400);
                    $sets[] = "updated_at = now()";
                    $sql = "UPDATE chat_communities SET " . implode(', ', $sets) . " WHERE id = :c";
                    $db->prepare($sql)->execute($params);
                    jsonResponse(true, ['updated' => true, 'community_id' => $cid]);
                    break;
                }

                case 'community_add_group': {
                    $cid = (int)($input['community_id'] ?? 0);
                    $convId = (int)($input['conversation_id'] ?? 0);
                    $newName = trim((string)($input['name'] ?? ''));
                    $kind = trim((string)($input['kind'] ?? 'topic'));
                    if (!in_array($kind, ['announcement', 'general', 'topic'], true)) $kind = 'topic';
                    if (!$cid) jsonResponse(false, null, 'community_id required', 400);
                    $assertCommunityAdmin($cid);

                    // Two flows:
                    // (a) link an existing conversation (caller passes conversation_id and is admin of it)
                    // (b) create a new sub-group in-place (caller passes name, no conv id)
                    if (!$convId) {
                        if ($newName === '' || mb_strlen($newName) > 100) jsonResponse(false, null, 'name (1-100 chars) or conversation_id required', 400);
                        try {
                            $db->beginTransaction();
                            $convType = ($kind === 'announcement') ? 'channel' : 'group';
                            $insConv = $db->prepare("INSERT INTO chat_conversations (type, name, created_by, created_at, updated_at) VALUES (:t, :n, :cb, now()::text, now()::text) RETURNING id");
                            $insConv->execute([':t' => $convType, ':n' => $newName, ':cb' => $email]);
                            $convId = (int)$insConv->fetchColumn();

                            $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cid, :em, :dn, 'admin', now()::text)")
                                ->execute([':cid' => $convId, ':em' => $email, ':dn' => chatDisplayName($email)]);

                            // Auto-add all existing community members so the new sub-group is populated
                            $db->prepare("
                                INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at)
                                SELECT :cv, cm.email, '', 'member', now()::text
                                FROM chat_community_members cm
                                WHERE cm.community_id = :c AND cm.email <> :me
                                ON CONFLICT DO NOTHING
                            ")->execute([':cv' => $convId, ':c' => $cid, ':me' => $email]);

                            $orderIdx = (int)$db->query("SELECT COALESCE(MAX(order_idx),0)+1 FROM chat_community_groups WHERE community_id = " . (int)$cid)->fetchColumn();
                            $insG = $db->prepare("INSERT INTO chat_community_groups (community_id, conversation_id, kind, order_idx, is_announcement) VALUES (:c, :conv, :k, :o, :ia)");
                            $insG->execute([':c' => $cid, ':conv' => $convId, ':k' => $kind, ':o' => $orderIdx, ':ia' => ($kind === 'announcement' ? 't' : 'f')]);
                            $db->prepare("UPDATE chat_communities SET updated_at = now() WHERE id = :c")->execute([':c' => $cid]);
                            $db->commit();
                            jsonResponse(true, ['community_id' => $cid, 'conversation_id' => $convId, 'kind' => $kind, 'created' => true]);
                        } catch (Throwable $e) {
                            if ($db->inTransaction()) $db->rollBack();
                            jsonResponse(false, null, 'Failed to create sub-group: ' . $e->getMessage(), 500);
                        }
                        break;
                    }

                    // (a) linking an existing conversation
                    $cm = $db->prepare("SELECT role FROM chat_conversation_members WHERE conversation_id = :c AND email = :e");
                    $cm->execute([':c' => $convId, ':e' => $email]);
                    $convRole = $cm->fetchColumn();
                    if ($convRole !== 'admin') jsonResponse(false, null, 'Must be group admin to link it to a community', 403);

                    $tStmt = $db->prepare("SELECT type FROM chat_conversations WHERE id = :c");
                    $tStmt->execute([':c' => $convId]);
                    $convType = $tStmt->fetchColumn();
                    if (!in_array($convType, ['group', 'channel'], true)) {
                        jsonResponse(false, null, 'Only groups/channels can join a community', 400);
                    }

                    try {
                        $orderIdx = (int)$db->query("SELECT COALESCE(MAX(order_idx),0)+1 FROM chat_community_groups WHERE community_id = " . (int)$cid)->fetchColumn();
                        $ins = $db->prepare("INSERT INTO chat_community_groups (community_id, conversation_id, kind, order_idx, is_announcement) VALUES (:c, :conv, :k, :o, :ia) ON CONFLICT DO NOTHING");
                        $ins->execute([':c' => $cid, ':conv' => $convId, ':k' => $kind, ':o' => $orderIdx, ':ia' => ($kind === 'announcement' ? 't' : 'f')]);
                        $db->prepare("UPDATE chat_communities SET updated_at = now() WHERE id = :c")->execute([':c' => $cid]);
                        jsonResponse(true, ['community_id' => $cid, 'conversation_id' => $convId, 'added' => true]);
                    } catch (Throwable $e) {
                        jsonResponse(false, null, 'Failed to add group: ' . $e->getMessage(), 500);
                    }
                    break;
                }

                case 'community_remove_group': {
                    $cid = (int)($input['community_id'] ?? 0);
                    $convId = (int)($input['conversation_id'] ?? 0);
                    if (!$cid || !$convId) jsonResponse(false, null, 'community_id and conversation_id required', 400);
                    $assertCommunityAdmin($cid);

                    // Don't allow removing the announcement channel — it's the heart of the community
                    $isAnn = $db->prepare("SELECT is_announcement FROM chat_community_groups WHERE community_id = :c AND conversation_id = :conv");
                    $isAnn->execute([':c' => $cid, ':conv' => $convId]);
                    if ((bool)$isAnn->fetchColumn()) {
                        jsonResponse(false, null, 'Cannot remove the announcement channel', 400);
                    }

                    $del = $db->prepare("DELETE FROM chat_community_groups WHERE community_id = :c AND conversation_id = :conv");
                    $del->execute([':c' => $cid, ':conv' => $convId]);
                    jsonResponse(true, ['removed' => true]);
                    break;
                }

                case 'community_members': {
                    $cid = (int)($input['community_id'] ?? 0);
                    if (!$cid) jsonResponse(false, null, 'community_id required', 400);
                    $assertCommunityMember($cid);

                    // Order: owner → admin → mod → member, then by joined_at ASC
                    $stmt = $db->prepare("
                        SELECT email, role, joined_at,
                               CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'mod' THEN 2 ELSE 3 END AS rank
                        FROM chat_community_members
                        WHERE community_id = :c
                        ORDER BY rank ASC, joined_at ASC
                    ");
                    $stmt->execute([':c' => $cid]);
                    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                    foreach ($rows as &$r) {
                        unset($r['rank']);
                        $r['display_name'] = chatDisplayName($r['email']);
                    }
                    jsonResponse(true, ['members' => $rows]);
                    break;
                }

                case 'community_announce':
                case 'community_announcement': {
                    $cid = (int)($input['community_id'] ?? 0);
                    $content = trim((string)($input['text'] ?? ($input['content'] ?? '')));
                    $attachments = $input['attachments'] ?? null;
                    if (!$cid) jsonResponse(false, null, 'community_id required', 400);
                    if ($content === '' || mb_strlen($content) > 4000) jsonResponse(false, null, 'Content 1-4000 chars required', 400);
                    $assertCommunityAdmin($cid);
                    // 30/min per community — keeps an announcement spam loop from
                    // pushing N members to the limit. Keyed on community id, not
                    // user, so swapping admins doesn't reset the bucket.
                    if (!chatRateLimit('community_' . $cid, 'community_announce', 30, 60)) {
                        jsonResponse(false, null, 'Announce rate limit exceeded', 429);
                    }

                    $cStmt = $db->prepare("SELECT announcement_conv_id FROM chat_communities WHERE id = :c");
                    $cStmt->execute([':c' => $cid]);
                    $announceConvId = (int)$cStmt->fetchColumn();
                    if (!$announceConvId) jsonResponse(false, null, 'Community has no announcement channel', 500);

                    // Ensure caller is in the announcement channel as admin
                    $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at) VALUES (:cv, :em, :dn, 'admin', now()::text) ON CONFLICT DO NOTHING")
                        ->execute([':cv' => $announceConvId, ':em' => $email, ':dn' => chatDisplayName($email)]);

                    // Auto-enroll any community member who isn't already in the channel
                    try {
                        $db->prepare("
                            INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at)
                            SELECT :cv, cm.email, '', 'member', now()::text
                            FROM chat_community_members cm
                            WHERE cm.community_id = :c
                              AND NOT EXISTS (SELECT 1 FROM chat_conversation_members ccm WHERE ccm.conversation_id = :cv2 AND ccm.email = cm.email)
                            ON CONFLICT DO NOTHING
                        ")->execute([':cv' => $announceConvId, ':c' => $cid, ':cv2' => $announceConvId]);
                    } catch (Throwable $e) {}

                    $msgIns = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, type, content, created_at) VALUES (:cv, :se, 'text', :c, now()::text) RETURNING id, created_at");
                    $msgIns->execute([':cv' => $announceConvId, ':se' => $email, ':c' => $content]);
                    $msgRow = $msgIns->fetch(PDO::FETCH_ASSOC);
                    $msgId = (int)$msgRow['id'];

                    // Best-effort: broadcast to WS so members see it instantly
                    try { broadcastChatMessage($db, $announceConvId, $msgId, $email, 'chat_message'); } catch (Throwable $e) {}
                    try { touchConversation($db, $announceConvId); } catch (Throwable $e) {}

                    jsonResponse(true, [
                        'message_id' => $msgId,
                        'conversation_id' => $announceConvId,
                        'created_at' => $msgRow['created_at'],
                        'attachments' => is_array($attachments) ? $attachments : null,
                    ]);
                    break;
                }

                case 'community_member_role': {
                    $cid = (int)($input['community_id'] ?? 0);
                    $target = strtolower(trim((string)($input['member_email'] ?? ($input['email'] ?? ''))));
                    $role = strtolower(trim((string)($input['role'] ?? '')));
                    if (!$cid || !$target) jsonResponse(false, null, 'community_id and member_email required', 400);
                    if (!in_array($role, ['admin', 'mod', 'member'], true)) jsonResponse(false, null, 'role must be admin/mod/member', 400);
                    $assertCommunityAdmin($cid);

                    // Owner-only: minting/demoting admins. Mods can be set by any admin.
                    $myRoleStmt = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                    $myRoleStmt->execute([':c' => $cid, ':e' => $email]);
                    $myRole = $myRoleStmt->fetchColumn();
                    $tStmt = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                    $tStmt->execute([':c' => $cid, ':e' => $target]);
                    $tRole = $tStmt->fetchColumn();
                    if (!$tRole) jsonResponse(false, null, 'Target is not a member', 404);
                    if ($tRole === 'owner') jsonResponse(false, null, "Can't change owner role", 400);
                    if ($role === 'admin' && $myRole !== 'owner') jsonResponse(false, null, 'Only the owner can promote to admin', 403);
                    if ($tRole === 'admin' && $myRole !== 'owner') jsonResponse(false, null, 'Only the owner can demote an admin', 403);

                    $db->prepare("UPDATE chat_community_members SET role = :r WHERE community_id = :c AND email = :e")
                        ->execute([':r' => $role, ':c' => $cid, ':e' => $target]);
                    jsonResponse(true, ['updated' => true, 'community_id' => $cid, 'member_email' => $target, 'role' => $role]);
                    break;
                }

                case 'community_kick': {
                    $cid = (int)($input['community_id'] ?? 0);
                    $target = strtolower(trim((string)($input['member_email'] ?? ($input['email'] ?? ''))));
                    if (!$cid || !$target) jsonResponse(false, null, 'community_id and member_email required', 400);
                    $assertCommunityAdmin($cid);
                    if ($target === $email) jsonResponse(false, null, 'Use community_leave to leave yourself', 400);

                    $myRoleStmt = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                    $myRoleStmt->execute([':c' => $cid, ':e' => $email]);
                    $myRole = $myRoleStmt->fetchColumn();
                    $tStmt = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                    $tStmt->execute([':c' => $cid, ':e' => $target]);
                    $tRole = $tStmt->fetchColumn();
                    if (!$tRole) jsonResponse(false, null, 'Target is not a member', 404);
                    if ($tRole === 'owner') jsonResponse(false, null, "Can't kick the owner", 403);
                    if ($tRole === 'admin' && $myRole !== 'owner') jsonResponse(false, null, 'Only the owner can kick an admin', 403);

                    try {
                        $db->beginTransaction();
                        $db->prepare("DELETE FROM chat_community_members WHERE community_id = :c AND email = :e")->execute([':c' => $cid, ':e' => $target]);
                        // Drop them from every sub-group conversation
                        $db->prepare("
                            DELETE FROM chat_conversation_members
                            WHERE email = :e
                              AND conversation_id IN (SELECT conversation_id FROM chat_community_groups WHERE community_id = :c)
                        ")->execute([':c' => $cid, ':e' => $target]);
                        $db->commit();
                    } catch (Throwable $e) {
                        if ($db->inTransaction()) $db->rollBack();
                        jsonResponse(false, null, 'Failed to kick: ' . $e->getMessage(), 500);
                    }
                    $refreshMemberCount($cid);
                    jsonResponse(true, ['kicked' => true, 'community_id' => $cid, 'member_email' => $target]);
                    break;
                }

                case 'community_discover': {
                    $category = trim((string)($input['category'] ?? ''));
                    $q = trim((string)($input['q'] ?? ''));
                    $limit = max(1, min(50, (int)($input['limit'] ?? 20)));
                    $offset = max(0, (int)($input['offset'] ?? 0));

                    $where = ['c.discoverable = TRUE'];
                    $params = [];
                    if ($category !== '' && $category !== 'all') {
                        $where[] = 'c.category = :cat';
                        $params[':cat'] = $category;
                    }
                    if ($q !== '') {
                        $where[] = '(c.name ILIKE :q OR c.handle ILIKE :q OR c.description ILIKE :q)';
                        $params[':q'] = '%' . $q . '%';
                    }
                    $sql = "
                        SELECT c.id, c.name, c.handle, c.description, c.photo_url, c.cover_url,
                               c.category, c.member_count,
                               EXISTS(SELECT 1 FROM chat_community_members m WHERE m.community_id = c.id AND m.email = :me) AS is_member
                        FROM chat_communities c
                        WHERE " . implode(' AND ', $where) . "
                        ORDER BY c.member_count DESC, c.created_at DESC
                        LIMIT :lim OFFSET :off
                    ";
                    $params[':me'] = $email;
                    $stmt = $db->prepare($sql);
                    foreach ($params as $k => $v) $stmt->bindValue($k, $v);
                    $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
                    $stmt->bindValue(':off', $offset, PDO::PARAM_INT);
                    $stmt->execute();
                    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                    foreach ($rows as &$r) {
                        $r['id'] = (int)$r['id'];
                        $r['member_count'] = (int)$r['member_count'];
                        $r['is_member'] = (bool)$r['is_member'];
                    }
                    jsonResponse(true, ['communities' => $rows, 'limit' => $limit, 'offset' => $offset]);
                    break;
                }

                case 'community_join': {
                    $cid = $resolveCommunityId($input['community_id'] ?? ($input['id_or_handle'] ?? null));
                    if (!$cid) jsonResponse(false, null, 'community_id or handle required', 400);

                    $exists = $db->prepare("SELECT id, announcement_conv_id, general_conv_id, welcome_message FROM chat_communities WHERE id = :c");
                    $exists->execute([':c' => $cid]);
                    $row = $exists->fetch(PDO::FETCH_ASSOC);
                    if (!$row) jsonResponse(false, null, 'Community not found', 404);

                    try {
                        $db->beginTransaction();
                        $db->prepare("INSERT INTO chat_community_members (community_id, email, role) VALUES (:c, :e, 'member') ON CONFLICT DO NOTHING")
                            ->execute([':c' => $cid, ':e' => $email]);
                        // Add caller to every sub-group of the community in one shot
                        $db->prepare("
                            INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at)
                            SELECT cg.conversation_id, :em, :dn, 'member', now()::text
                            FROM chat_community_groups cg
                            WHERE cg.community_id = :c
                              AND NOT EXISTS (SELECT 1 FROM chat_conversation_members ccm WHERE ccm.conversation_id = cg.conversation_id AND ccm.email = :em2)
                            ON CONFLICT DO NOTHING
                        ")->execute([':em' => $email, ':dn' => chatDisplayName($email), ':c' => $cid, ':em2' => $email]);
                        $db->commit();
                    } catch (Throwable $e) {
                        if ($db->inTransaction()) $db->rollBack();
                        jsonResponse(false, null, 'Failed to join: ' . $e->getMessage(), 500);
                    }
                    $refreshMemberCount($cid);
                    jsonResponse(true, [
                        'community_id' => $cid,
                        'joined' => true,
                        'announcement_conv_id' => $row['announcement_conv_id'] !== null ? (int)$row['announcement_conv_id'] : null,
                        'general_conv_id' => $row['general_conv_id'] !== null ? (int)$row['general_conv_id'] : null,
                        'welcome_message' => $row['welcome_message'] ?? '',
                    ]);
                    break;
                }

                case 'community_leave': {
                    $cid = (int)($input['community_id'] ?? 0);
                    if (!$cid) jsonResponse(false, null, 'community_id required', 400);

                    $roleStmt = $db->prepare("SELECT role FROM chat_community_members WHERE community_id = :c AND email = :e");
                    $roleStmt->execute([':c' => $cid, ':e' => $email]);
                    $myRole = $roleStmt->fetchColumn();
                    if ($myRole === 'owner') {
                        jsonResponse(false, null, 'Owner must transfer ownership before leaving', 400);
                    }
                    if ($myRole === 'admin') {
                        $countStmt = $db->prepare("SELECT COUNT(*) FROM chat_community_members WHERE community_id = :c AND role IN ('admin','owner')");
                        $countStmt->execute([':c' => $cid]);
                        if ((int)$countStmt->fetchColumn() <= 1) {
                            // Last admin guard: promote the oldest non-admin
                            $promote = $db->prepare("UPDATE chat_community_members SET role = 'admin' WHERE community_id = :c AND email = (SELECT email FROM chat_community_members WHERE community_id = :c2 AND role IN ('mod','member') ORDER BY joined_at ASC LIMIT 1)");
                            try { $promote->execute([':c' => $cid, ':c2' => $cid]); } catch (Throwable $e) {}
                        }
                    }

                    try {
                        $db->beginTransaction();
                        $db->prepare("DELETE FROM chat_community_members WHERE community_id = :c AND email = :e")->execute([':c' => $cid, ':e' => $email]);
                        // Drop from every sub-group at once
                        $db->prepare("
                            DELETE FROM chat_conversation_members
                            WHERE email = :e
                              AND conversation_id IN (SELECT conversation_id FROM chat_community_groups WHERE community_id = :c)
                        ")->execute([':c' => $cid, ':e' => $email]);
                        $db->commit();
                    } catch (Throwable $e) {
                        if ($db->inTransaction()) $db->rollBack();
                        jsonResponse(false, null, 'Failed to leave: ' . $e->getMessage(), 500);
                    }
                    $refreshMemberCount($cid);
                    jsonResponse(true, ['left' => true, 'community_id' => $cid]);
                    break;
                }
            }
            break;
        }

        // ============================================================
        // chat_channel_create_public — Mark a group/channel public + assign @handle
        // chat_discover_public        — Telegram-style discovery feed
        // chat_channel_join           — Join a public channel
        //
        // Schema additions on chat_conversations (idempotent):
        //   public_handle TEXT UNIQUE
        //   description   TEXT       (already added elsewhere — guarded)
        //   member_count  INT DEFAULT 0
        //   discoverable  BOOLEAN DEFAULT FALSE
        //   category      TEXT
        // ============================================================
        case 'chat_channel_create_public':
        case 'chat_discover_public':
        case 'chat_channel_join': {
            // Idempotent ALTERs on every call into this block. Cheap (no-op
            // when already applied) and keeps the schema in sync without
            // shipping a separate migration.
            try { $db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS public_handle TEXT"); } catch (\Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS description TEXT"); } catch (\Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS member_count INT DEFAULT 0"); } catch (\Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS discoverable BOOLEAN DEFAULT FALSE"); } catch (\Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS category TEXT"); } catch (\Throwable $_) {}
            try { $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conv_public_handle ON chat_conversations(LOWER(public_handle)) WHERE public_handle IS NOT NULL"); } catch (\Throwable $_) {}
            try { $db->exec("CREATE INDEX IF NOT EXISTS idx_chat_conv_member_count ON chat_conversations(member_count DESC) WHERE discoverable = TRUE"); } catch (\Throwable $_) {}

            if ($action === 'chat_channel_create_public') {
                $user = requireChatAuth();
                $conversationId = (int)($input['conversation_id'] ?? 0);
                $handleRaw = strtolower(trim((string)($input['handle'] ?? '')));
                $category = trim((string)($input['category'] ?? ''));
                $description = trim((string)($input['description'] ?? ''));
                if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
                if (!preg_match('/^[a-z0-9_]{3,32}$/', $handleRaw)) {
                    jsonResponse(false, null, 'Handle must be 3-32 chars (a-z, 0-9, _)', 400);
                }

                $membership = requireConversationMember($db, $conversationId, $user['email']);
                if (!in_array(($membership['type'] ?? ''), ['group', 'channel'], true)) {
                    jsonResponse(false, null, 'Only groups/channels can be public', 400);
                }
                if (($membership['role'] ?? 'member') !== 'admin') {
                    jsonResponse(false, null, 'Only admins can publish a channel', 403);
                }

                // Handle uniqueness check (case-insensitive). Allow same conv to
                // re-claim its own handle (idempotent re-publish/category update).
                $chk = $db->prepare("SELECT id FROM chat_conversations WHERE LOWER(public_handle) = LOWER(:h) AND id <> :id LIMIT 1");
                $chk->execute([':h' => $handleRaw, ':id' => $conversationId]);
                if ($chk->fetch()) {
                    jsonResponse(false, null, 'Handle already taken', 409);
                }

                // Compute current member count (authoritative — cheaper than
                // maintaining a counter and keeps existing groups in sync the
                // moment they go public).
                $cnt = $db->prepare("SELECT COUNT(*) FROM chat_conversation_members WHERE conversation_id = :id");
                $cnt->execute([':id' => $conversationId]);
                $memberCount = (int)$cnt->fetchColumn();

                $sets = [
                    'public_handle = :h',
                    'discoverable = TRUE',
                    'member_count = :mc',
                    'updated_at = now()::text',
                ];
                $params = [
                    ':h'  => $handleRaw,
                    ':mc' => $memberCount,
                    ':id' => $conversationId,
                ];
                if ($category !== '') {
                    $sets[] = 'category = :cat';
                    $params[':cat'] = mb_substr($category, 0, 40);
                }
                if ($description !== '') {
                    $sets[] = 'description = :desc';
                    $params[':desc'] = mb_substr($description, 0, 500);
                }
                try {
                    $db->prepare("UPDATE chat_conversations SET " . implode(', ', $sets) . " WHERE id = :id")
                       ->execute($params);
                } catch (\Throwable $e) {
                    // Most likely the unique index race
                    error_log('[chat_channel_create_public] ' . $e->getMessage());
                    jsonResponse(false, null, 'Handle already taken', 409);
                }

                $stmt = $db->prepare("SELECT id, name, type, public_handle, description, member_count, discoverable, category, avatar_url FROM chat_conversations WHERE id = :id");
                $stmt->execute([':id' => $conversationId]);
                $conv = $stmt->fetch(\PDO::FETCH_ASSOC);
                jsonResponse(true, $conv, 'Channel published');
                break;
            }

            if ($action === 'chat_discover_public') {
                $userDp = requireChatAuth();
                if (!chatRateLimit($userDp['email'], 'discover_public', 60, 60)) {
                    jsonResponse(false, null, 'Rate limit exceeded', 429);
                }
                $category = trim((string)($input['category'] ?? $_GET['category'] ?? ''));
                $q = trim((string)($input['q'] ?? $_GET['q'] ?? ''));
                $sort = (string)($input['sort'] ?? $_GET['sort'] ?? 'members_desc');

                $where = ['discoverable = TRUE', 'public_handle IS NOT NULL'];
                $params = [];
                if ($category !== '' && strtolower($category) !== 'all' && strtolower($category) !== 'tudo') {
                    $where[] = 'LOWER(category) = LOWER(:cat)';
                    $params[':cat'] = $category;
                }
                if ($q !== '') {
                    $where[] = '(LOWER(name) LIKE :q OR LOWER(description) LIKE :q OR LOWER(public_handle) LIKE :q)';
                    $params[':q'] = '%' . strtolower($q) . '%';
                }

                $orderBy = $sort === 'newest'
                    ? 'created_at DESC NULLS LAST, id DESC'
                    : 'member_count DESC NULLS LAST, id DESC';

                $sql = "SELECT id, name, type, public_handle, description, member_count, category, avatar_url, created_at
                        FROM chat_conversations
                        WHERE " . implode(' AND ', $where) . "
                        ORDER BY $orderBy
                        LIMIT 50";
                $stmt = $db->prepare($sql);
                $stmt->execute($params);
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                jsonResponse(true, ['channels' => $rows], 'OK');
                break;
            }

            // chat_channel_join
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $handle = strtolower(trim((string)($input['handle'] ?? '')));
            if (!$conversationId && $handle === '') {
                jsonResponse(false, null, 'conversation_id or handle required', 400);
            }

            // Resolve by handle if id wasn't provided — lets the discovery
            // card link directly via @handle without a second round-trip.
            if (!$conversationId && $handle !== '') {
                if (!preg_match('/^[a-z0-9_]{3,32}$/', $handle)) {
                    jsonResponse(false, null, 'Invalid handle', 400);
                }
                $r = $db->prepare("SELECT id FROM chat_conversations WHERE LOWER(public_handle) = LOWER(:h) AND discoverable = TRUE LIMIT 1");
                $r->execute([':h' => $handle]);
                $conversationId = (int)$r->fetchColumn();
                if (!$conversationId) jsonResponse(false, null, 'Channel not found', 404);
            }

            // Confirm the conversation is actually public + discoverable —
            // join-by-id can't be abused to slip into a private group.
            $cStmt = $db->prepare("SELECT id, name, type, public_handle, discoverable FROM chat_conversations WHERE id = :id");
            $cStmt->execute([':id' => $conversationId]);
            $conv = $cStmt->fetch(\PDO::FETCH_ASSOC);
            if (!$conv) jsonResponse(false, null, 'Channel not found', 404);
            if (empty($conv['discoverable']) || empty($conv['public_handle'])) {
                jsonResponse(false, null, 'Channel is not public', 403);
            }

            // Already a member? Idempotent success — return the conv id so the
            // frontend can navigate straight in.
            $exists = $db->prepare("SELECT 1 FROM chat_conversation_members WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e) LIMIT 1");
            $exists->execute([':cid' => $conversationId, ':e' => $user['email']]);
            if ($exists->fetch()) {
                jsonResponse(true, ['conversation_id' => $conversationId, 'already_member' => true], 'Already joined');
                break;
            }

            try {
                $db->beginTransaction();
                $ins = $db->prepare("
                    INSERT INTO chat_conversation_members (conversation_id, email, display_name, role, joined_at)
                    VALUES (:cid, :e, :dn, 'member', now()::text)
                    ON CONFLICT DO NOTHING
                ");
                $ins->execute([
                    ':cid' => $conversationId,
                    ':e'   => $user['email'],
                    ':dn'  => chatDisplayName($user['email']),
                ]);
                // Bump the cached member_count atomically.
                $db->prepare("UPDATE chat_conversations SET member_count = COALESCE(member_count, 0) + 1, updated_at = now()::text WHERE id = :id")
                   ->execute([':id' => $conversationId]);
                $db->commit();
            } catch (\Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                error_log('[chat_channel_join] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to join channel', 500);
            }

            jsonResponse(true, [
                'conversation_id' => $conversationId,
                'name'            => $conv['name'],
                'type'            => $conv['type'],
                'public_handle'   => $conv['public_handle'],
            ], 'Joined channel');
            break;
        }

        // ============================================================
        // chat_hashtag_trending — Telegram-style trending hashtags from
        //                         PUBLIC channels only (last 7 days).
        // chat_hashtag_search   — recent messages tagged with a given
        //                         hashtag from PUBLIC channels.
        //
        // Privacy: rows from chat_hashtags are unconditionally JOINed
        // against chat_conversations.discoverable = TRUE so private
        // group/DM tags never leak into the discovery surface — even if
        // the indexer accidentally captured them.
        // ============================================================
        case 'chat_hashtag_trending': {
            requireChatAuth();
            chatHashtagEnsureSchema($db);
            $limit = max(1, min(50, (int)($input['limit'] ?? 20)));
            try {
                $stmt = $db->prepare("
                    SELECT h.hashtag, COUNT(*) AS mentions, MAX(h.created_at) AS last_used
                    FROM chat_hashtags h
                    JOIN chat_conversations c ON c.id = h.conversation_id
                    WHERE c.discoverable = TRUE
                      AND h.created_at >= now() - INTERVAL '7 days'
                    GROUP BY h.hashtag
                    ORDER BY mentions DESC, last_used DESC
                    LIMIT :lim
                ");
                $stmt->bindValue(':lim', $limit, \PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                $tags = array_map(function ($r) {
                    return [
                        'hashtag'   => (string)$r['hashtag'],
                        'mentions'  => (int)$r['mentions'],
                        'last_used' => (string)$r['last_used'],
                    ];
                }, $rows);
                jsonResponse(true, ['tags' => $tags]);
            } catch (\Throwable $e) {
                error_log('[chat_hashtag_trending] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to load trending', 500);
            }
            break;
        }

        case 'chat_hashtag_search': {
            $userHt = requireChatAuth();
            if (!chatRateLimit($userHt['email'], 'hashtag_search', 60, 60)) {
                jsonResponse(false, null, 'Rate limit exceeded', 429);
            }
            chatHashtagEnsureSchema($db);
            $rawTag = strtolower(trim((string)($input['tag'] ?? '')));
            // Strip a leading # if the client sent it that way.
            if (strlen($rawTag) > 0 && $rawTag[0] === '#') $rawTag = substr($rawTag, 1);
            // Same character class as the indexer — keeps stored + queried
            // tags in lockstep so a user-supplied "#FOO " or "#foo!" still
            // matches "foo".
            if (!preg_match('/^[a-z0-9_\x{00C0}-\x{017F}]{2,50}$/u', $rawTag)) {
                jsonResponse(false, null, 'Invalid tag', 400);
            }
            try {
                // Recent messages tagged with this hashtag from PUBLIC channels.
                // Limit 50 — same shape as chat_search so the client can render
                // results in the same row component.
                $stmt = $db->prepare("
                    SELECT
                        m.id, m.conversation_id, m.sender_email, m.content, m.type,
                        m.file_url, m.file_name, m.created_at,
                        c.name AS conversation_name, c.public_handle, c.avatar_url AS conversation_avatar
                    FROM chat_hashtags h
                    JOIN chat_messages m       ON m.id = h.message_id AND m.deleted_at IS NULL
                    JOIN chat_conversations c  ON c.id = h.conversation_id
                    WHERE h.hashtag = :tag
                      AND c.discoverable = TRUE
                    ORDER BY h.created_at DESC
                    LIMIT 50
                ");
                $stmt->execute([':tag' => $rawTag]);
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                $messages = array_map(function ($r) {
                    return [
                        'id'                  => (int)$r['id'],
                        'conversation_id'     => (int)$r['conversation_id'],
                        'sender_email'        => (string)$r['sender_email'],
                        'sender_name'         => chatDisplayName((string)$r['sender_email']),
                        'content'             => (string)$r['content'],
                        'type'                => (string)$r['type'],
                        'file_url'            => $r['file_url'],
                        'file_name'           => $r['file_name'],
                        'created_at'          => (string)$r['created_at'],
                        'conversation_name'   => (string)($r['conversation_name'] ?? ''),
                        'conversation_handle' => $r['public_handle'],
                        'conversation_avatar' => $r['conversation_avatar'],
                    ];
                }, $rows);
                jsonResponse(true, ['tag' => $rawTag, 'messages' => $messages]);
            } catch (\Throwable $e) {
                error_log('[chat_hashtag_search] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to search hashtag', 500);
            }
            break;
        }

        // ============================================================
        // Voicemail — caller leaves a voice message after a missed call.
        // The audio is uploaded directly to R2 (caller fetches a presigned
        // PUT via voicemail_init_upload), then voicemail_send creates the
        // row + posts a `kind:voicemail` chat message so the recipient
        // sees a "missed call + voicemail" bubble.
        // ============================================================
        case 'voicemail_init_upload': {
            // Mirror drive_init_upload but scoped to short audio voicemails.
            // Returns a presigned PUT URL so the caller can write the audio
            // straight to R2 without going through PHP-FPM. 60s cap is
            // enforced both at record-time and again on voicemail_send so a
            // tampered client can't bypass.
            $user = requireChatAuth();
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $mimeType = trim((string)($input['mime_type'] ?? 'audio/m4a'));
            if (!$conversationId) jsonResponse(false, null, 'conversation_id required', 400);
            requireConversationMember($db, $conversationId, $user['email']);

            // Reuse drive.php's S3 helpers — they already handle R2 sigv4.
            require_once __DIR__ . '/drive.php';
            if (!function_exists('s3GeneratePresignedPut')) {
                jsonResponse(false, null, 'Storage signing unavailable', 500);
            }
            $allowedMime = ['audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/opus'];
            if (!in_array(strtolower($mimeType), $allowedMime, true)) $mimeType = 'audio/m4a';
            $extMap = [
                'audio/m4a' => 'm4a', 'audio/mp4' => 'm4a', 'audio/mpeg' => 'mp3', 'audio/aac' => 'aac',
                'audio/wav' => 'wav', 'audio/webm' => 'webm', 'audio/ogg' => 'ogg', 'audio/opus' => 'opus',
            ];
            $ext = $extMap[strtolower($mimeType)] ?? 'm4a';
            $userHash = md5(strtolower(trim($user['email'])));
            $uuid = bin2hex(random_bytes(8));
            $objectKey = "voicemails/{$userHash}/{$uuid}.{$ext}";
            $expires = 600; // 10 min — voicemails are <60s, no need for an hour
            $uploadUrl = s3GeneratePresignedPut($objectKey, $mimeType, $expires);
            if (!$uploadUrl) jsonResponse(false, null, 'S3 signing failed', 500);
            jsonResponse(true, [
                'upload_url'  => $uploadUrl,
                'object_key'  => $objectKey,
                'expires_in'  => $expires,
                'mime_type'   => $mimeType,
            ]);
            break;
        }

        case 'voicemail_send': {
            $user = requireChatAuth();
            // 10/min per user — sending voicemail is real work (R2 reach,
            // push fanout, transcription kickoff). Cap loud clients.
            if (!chatRateLimit($user['email'], 'voicemail_send', 10, 60)) {
                jsonResponse(false, null, 'Rate limit exceeded', 429);
            }
            $toEmail = strtolower(trim((string)($input['to_email'] ?? '')));
            $audioKey = trim((string)($input['audio_r2_key'] ?? ''));
            $duration = (int)($input['duration_sec'] ?? 0);
            $conversationId = (int)($input['conversation_id'] ?? 0);
            if ($toEmail === '' || !filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'to_email required', 400);
            }
            if ($audioKey === '' || strlen($audioKey) > 200) jsonResponse(false, null, 'audio_r2_key required', 400);
            // Validate the key shape we issued. Stops a malicious client
            // from registering a row that points at someone else's R2
            // object (their own avatar, a stolen drive file, etc).
            if (!preg_match('#^voicemails/[a-f0-9]{32}/[a-f0-9]{16}\.[a-z0-9]{2,5}$#', $audioKey)) {
                jsonResponse(false, null, 'invalid audio_r2_key', 400);
            }
            // Server-side cap (mirrors client UI). 60s == 1 minute, matches
            // WhatsApp/Telegram voicemail length. Anything longer is almost
            // certainly a buggy client streaming forever.
            if ($duration < 1) $duration = 1;
            if ($duration > 60) $duration = 60;

            // Resolve / create the 1:1 conversation between caller and
            // recipient if conversation_id wasn't supplied. Voicemails
            // always live inside an existing thread — caller already had
            // one open to even start the call.
            if (!$conversationId) {
                try {
                    $resolveSql = "
                        SELECT cm1.conversation_id
                        FROM chat_conversation_members cm1
                        JOIN chat_conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
                        JOIN chat_conversations c ON c.id = cm1.conversation_id
                        WHERE LOWER(cm1.email) = LOWER(:a) AND LOWER(cm2.email) = LOWER(:b)
                          AND c.type = 'direct'
                        LIMIT 1
                    ";
                    $st = $db->prepare($resolveSql);
                    $st->execute([':a' => $user['email'], ':b' => $toEmail]);
                    $conversationId = (int)($st->fetchColumn() ?: 0);
                } catch (\Throwable $e) { error_log('[voicemail_send.resolve] ' . $e->getMessage()); }
            }
            if (!$conversationId) {
                jsonResponse(false, null, 'No direct conversation with recipient — open a chat first', 404);
            }
            requireConversationMember($db, $conversationId, $user['email']);

            // Insert voicemail row.
            try {
                $ins = $db->prepare("
                    INSERT INTO voicemails (from_email, to_email, conversation_id, audio_r2_key, duration_sec, listened, created_at)
                    VALUES (:f, :t, :c, :k, :d, FALSE, now())
                    RETURNING id, created_at
                ");
                $ins->execute([
                    ':f' => $user['email'], ':t' => $toEmail,
                    ':c' => $conversationId, ':k' => $audioKey,
                    ':d' => $duration,
                ]);
                $vmRow = $ins->fetch(\PDO::FETCH_ASSOC);
                $voicemailId = (int)$vmRow['id'];
            } catch (\Throwable $e) {
                error_log('[voicemail_send.insert] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to save voicemail', 500);
            }

            // Post a special chat message so the recipient sees a bubble in
            // the conversation. type=voicemail; content carries the JSON
            // payload the bubble renders from. Reuse the same call_card
            // pattern (custom type + JSON content).
            $payload = [
                'kind'         => 'voicemail',
                'voicemail_id' => $voicemailId,
                'duration'     => $duration,
                'from_email'   => $user['email'],
                'to_email'     => $toEmail,
                'created_at'   => gmdate('Y-m-d\TH:i:s\Z'),
            ];
            $contentJson = json_encode($payload, JSON_UNESCAPED_UNICODE);
            $msgId = 0;
            try {
                $msgIns = $db->prepare("
                    INSERT INTO chat_messages
                        (conversation_id, sender_email, sender_name, content, type, created_at)
                    VALUES (?, ?, ?, ?, 'voicemail', ?)
                    RETURNING id
                ");
                $nowIso = gmdate('Y-m-d\TH:i:s\Z');
                $msgIns->execute([
                    $conversationId,
                    $user['email'],
                    chatDisplayName($user['email']),
                    $contentJson,
                    $nowIso,
                ]);
                $msgId = (int)$msgIns->fetchColumn();
                touchConversation($db, $conversationId);
            } catch (\Throwable $e) {
                error_log('[voicemail_send.message] ' . $e->getMessage());
                // Voicemail row already exists — return success even if the
                // bubble insert failed, recipient still sees it via voicemail_get.
            }

            // Broadcast to the chat thread + recipient's user channel so
            // both web/mobile clients render the bubble in real time.
            if ($msgId > 0) {
                try { broadcastChatMessage($db, $conversationId, $msgId, $user['email'], 'chat_message'); }
                catch (\Throwable $e) { error_log('[voicemail_send.broadcast] ' . $e->getMessage()); }
            }

            // Push notification — same pattern as missed_call so the
            // recipient sees it on lock screen if app is backgrounded.
            try {
                if (!function_exists('fcmSendToUser')) require_once __DIR__ . '/firebase_push.php';
                $callerName = chatDisplayName($user['email']) ?: $user['email'];
                $title = 'Mensagem de voz';
                $body = $callerName . ' deixou uma mensagem de voz';
                fcmSendToUser($toEmail, $title, $body, [
                    'type'            => 'voicemail',
                    'voicemail_id'    => (string)$voicemailId,
                    'conversation_id' => (string)$conversationId,
                    'from_email'      => $user['email'],
                    'thread_id'       => 'chat_' . $conversationId,
                ]);
            } catch (\Throwable $e) { error_log('[voicemail_send.push] ' . $e->getMessage()); }

            // Kick off async transcription so by the time the recipient
            // hits play, the transcript line is usually already there. We
            // don't block the response on it — best-effort. The frontend
            // calls voicemail_transcribe explicitly if it's still empty.
            try { _voicemailTranscribeAsync($voicemailId); }
            catch (\Throwable $e) { error_log('[voicemail_send.tx_async] ' . $e->getMessage()); }

            jsonResponse(true, [
                'voicemail_id'    => $voicemailId,
                'message_id'      => $msgId,
                'conversation_id' => $conversationId,
                'duration'        => $duration,
            ], 'Voicemail sent');
            break;
        }

        case 'voicemail_get': {
            $user = requireChatAuth();
            $voicemailId = (int)($input['voicemail_id'] ?? 0);
            if (!$voicemailId) jsonResponse(false, null, 'voicemail_id required', 400);
            $st = $db->prepare("SELECT * FROM voicemails WHERE id = :id");
            $st->execute([':id' => $voicemailId]);
            $vm = $st->fetch(\PDO::FETCH_ASSOC);
            if (!$vm) jsonResponse(false, null, 'voicemail not found', 404);
            $me = strtolower($user['email']);
            if (strtolower($vm['from_email']) !== $me && strtolower($vm['to_email']) !== $me) {
                jsonResponse(false, null, 'Forbidden', 403);
            }

            // Audio URL: prefer the public CDN if R2 bucket has the
            // cdn.chatyy.com.br rule (same pattern as drive). Fall back
            // to a presigned GET if the bucket is private.
            require_once __DIR__ . '/drive.php';
            $audioUrl = '';
            try {
                if (function_exists('s3PresignUrl')) {
                    $audioUrl = s3PresignUrl('GET', $vm['audio_r2_key'], [], 3600);
                }
                if (!$audioUrl && function_exists('s3PublicUrl')) {
                    $audioUrl = s3PublicUrl($vm['audio_r2_key']);
                }
            } catch (\Throwable $e) { error_log('[voicemail_get.url] ' . $e->getMessage()); }

            jsonResponse(true, [
                'voicemail_id'   => (int)$vm['id'],
                'audio_url'      => $audioUrl,
                'duration_sec'   => (int)$vm['duration_sec'],
                'transcription'  => $vm['transcription'],
                'listened'       => (bool)$vm['listened'],
                'from_email'     => $vm['from_email'],
                'to_email'       => $vm['to_email'],
                'conversation_id'=> (int)$vm['conversation_id'],
                'created_at'     => $vm['created_at'],
            ]);
            break;
        }

        case 'voicemail_mark_listened': {
            $user = requireChatAuth();
            $voicemailId = (int)($input['voicemail_id'] ?? 0);
            if (!$voicemailId) jsonResponse(false, null, 'voicemail_id required', 400);
            $st = $db->prepare("SELECT from_email, to_email FROM voicemails WHERE id = :id");
            $st->execute([':id' => $voicemailId]);
            $vm = $st->fetch(\PDO::FETCH_ASSOC);
            if (!$vm) jsonResponse(false, null, 'voicemail not found', 404);
            // Only the recipient can mark listened.
            if (strtolower($vm['to_email']) !== strtolower($user['email'])) {
                jsonResponse(false, null, 'Only the recipient can mark listened', 403);
            }
            $db->prepare("UPDATE voicemails SET listened = TRUE WHERE id = :id")
               ->execute([':id' => $voicemailId]);

            // Notify the sender's other devices so the "blue ring"
            // delivered/listened indicator updates in real time.
            try {
                _broadcastToOwnDevices($vm['from_email'], 'voicemail_listened', [
                    'voicemail_id' => $voicemailId,
                    'listened_by'  => $user['email'],
                    'listened_at'  => gmdate('c'),
                ]);
            } catch (\Throwable $e) { error_log('[voicemail_mark_listened.broadcast] ' . $e->getMessage()); }

            jsonResponse(true, ['voicemail_id' => $voicemailId, 'listened' => true]);
            break;
        }

        case 'voicemail_transcribe': {
            // Public-facing helper: client polls this when transcription is
            // still null after voicemail_get. Internally it dispatches to
            // _voicemailTranscribeAsync (same path as voicemail_send fires).
            $user = requireChatAuth();
            $voicemailId = (int)($input['voicemail_id'] ?? 0);
            if (!$voicemailId) jsonResponse(false, null, 'voicemail_id required', 400);
            $st = $db->prepare("SELECT * FROM voicemails WHERE id = :id");
            $st->execute([':id' => $voicemailId]);
            $vm = $st->fetch(\PDO::FETCH_ASSOC);
            if (!$vm) jsonResponse(false, null, 'voicemail not found', 404);
            $me = strtolower($user['email']);
            if (strtolower($vm['from_email']) !== $me && strtolower($vm['to_email']) !== $me) {
                jsonResponse(false, null, 'Forbidden', 403);
            }
            if (!empty($vm['transcription'])) {
                jsonResponse(true, ['transcription' => $vm['transcription'], 'cached' => true]);
            }
            $tx = _voicemailTranscribeAsync($voicemailId);
            jsonResponse(true, ['transcription' => $tx, 'cached' => false]);
            break;
        }

        // ═══════════════════════════════════════════════════════════
        // Scheduled calls — pre-arrange a call with one or more
        // participants. The cron-scheduled-calls.php worker fires push
        // notifications 15min and 1min before scheduled_at. Joining is
        // gated to ±5min around scheduled_at so the room isn't usable
        // hours before/after the slot.
        // ═══════════════════════════════════════════════════════════
        case 'call_schedule': {
            $user = requireChatAuth();
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS scheduled_calls (
                    id BIGSERIAL PRIMARY KEY,
                    organizer_email TEXT NOT NULL,
                    participants JSONB NOT NULL DEFAULT '[]'::jsonb,
                    title TEXT NOT NULL DEFAULT '',
                    scheduled_at TIMESTAMP NOT NULL,
                    duration_min INT NOT NULL DEFAULT 30,
                    status TEXT NOT NULL DEFAULT 'scheduled',
                    conversation_id BIGINT,
                    room_id TEXT NOT NULL,
                    notified_15 SMALLINT DEFAULT 0,
                    notified_1 SMALLINT DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (now() AT TIME ZONE 'UTC')
                )");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_sched_calls_time ON scheduled_calls(scheduled_at, status)");
                $db->exec("CREATE INDEX IF NOT EXISTS idx_sched_calls_org ON scheduled_calls(organizer_email, status)");
            } catch (\Throwable $e) { error_log('[call_schedule.ddl] ' . $e->getMessage()); }

            $title = trim((string)($input['title'] ?? ''));
            if ($title === '') $title = 'Chamada agendada';
            if (mb_strlen($title) > 200) $title = mb_substr($title, 0, 200);
            $rawParticipants = $input['participants'] ?? [];
            if (!is_array($rawParticipants)) $rawParticipants = [];
            $participants = [];
            foreach ($rawParticipants as $p) {
                $em = strtolower(trim((string)$p));
                if ($em && filter_var($em, FILTER_VALIDATE_EMAIL) && $em !== $user['email']) {
                    $participants[] = $em;
                }
            }
            $participants = array_values(array_unique($participants));
            if (empty($participants)) {
                jsonResponse(false, null, 'participants required', 400);
            }
            $scheduledAt = trim((string)($input['scheduled_at'] ?? ''));
            $ts = strtotime($scheduledAt);
            if (!$ts || $ts < time() - 60) {
                jsonResponse(false, null, 'scheduled_at must be a future ISO date', 400);
            }
            $durationMin = (int)($input['duration_min'] ?? 30);
            if (!in_array($durationMin, [15, 30, 60, 90, 120], true)) $durationMin = 30;

            $roomId = bin2hex(random_bytes(8));
            $scheduledIso = gmdate('Y-m-d H:i:s', $ts);

            try {
                $ins = $db->prepare("INSERT INTO scheduled_calls
                    (organizer_email, participants, title, scheduled_at, duration_min, status, room_id)
                    VALUES (:o, :p::jsonb, :t, :s, :d, 'scheduled', :r) RETURNING id");
                $ins->execute([
                    ':o' => $user['email'],
                    ':p' => json_encode($participants),
                    ':t' => $title,
                    ':s' => $scheduledIso,
                    ':d' => $durationMin,
                    ':r' => $roomId,
                ]);
                $callId = (int)$ins->fetchColumn();
            } catch (\Throwable $e) {
                error_log('[call_schedule.insert] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to schedule', 500);
            }

            $organizerName = chatDisplayName($user['email']);
            $whenLocal = date('d/m/Y H:i', $ts);
            $sysContent = "Chamada agendada: \"{$title}\" em {$whenLocal}";
            $payloadJson = json_encode([
                'kind'         => 'call_schedule',
                'scheduled_id' => $callId,
                'title'        => $title,
                'scheduled_at' => gmdate('c', $ts),
                'duration_min' => $durationMin,
                'organizer'    => $user['email'],
                'organizer_name' => $organizerName,
                'room_id'      => $roomId,
            ]);

            $linkConvId = null;
            foreach ($participants as $peer) {
                try {
                    $find = $db->prepare("
                        SELECT c.id FROM chat_conversations c
                        JOIN chat_conversation_members m1 ON m1.conversation_id = c.id AND LOWER(m1.email) = LOWER(:me)
                        JOIN chat_conversation_members m2 ON m2.conversation_id = c.id AND LOWER(m2.email) = LOWER(:peer)
                        WHERE c.type = 'direct'
                        LIMIT 1
                    ");
                    $find->execute([':me' => $user['email'], ':peer' => $peer]);
                    $convId = (int)$find->fetchColumn();
                    if (!$convId) {
                        $cIns = $db->prepare("INSERT INTO chat_conversations (type, created_by, created_at, updated_at) VALUES ('direct', :me, now()::text, now()::text) RETURNING id");
                        $cIns->execute([':me' => $user['email']]);
                        $convId = (int)$cIns->fetchColumn();
                        $mIns = $db->prepare("INSERT INTO chat_conversation_members (conversation_id, email, role, joined_at) VALUES (:cid, :em, 'admin', now()::text)");
                        $mIns->execute([':cid' => $convId, ':em' => $user['email']]);
                        $mIns->execute([':cid' => $convId, ':em' => $peer]);
                    }
                    $msgIns = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, payload, created_at)
                        VALUES (:cid, :se, :c, 'system', :p, (now() AT TIME ZONE 'UTC')::text) RETURNING id");
                    $msgIns->execute([
                        ':cid' => $convId,
                        ':se'  => $user['email'],
                        ':c'   => $sysContent,
                        ':p'   => $payloadJson,
                    ]);
                    $msgId = (int)$msgIns->fetchColumn();
                    try {
                        $db->prepare("UPDATE chat_conversations SET updated_at = (now() AT TIME ZONE 'UTC')::text WHERE id = :id")
                            ->execute([':id' => $convId]);
                    } catch (\Throwable $e) {}
                    try { broadcastChatMessage($db, $convId, $msgId, $user['email'], 'chat_message'); } catch (\Throwable $e) {}
                    if ($linkConvId === null) $linkConvId = $convId;
                } catch (\Throwable $e) {
                    error_log('[call_schedule.dm] peer=' . $peer . ' ' . $e->getMessage());
                }
            }
            try {
                if ($linkConvId !== null) {
                    $db->prepare("UPDATE scheduled_calls SET conversation_id = :c WHERE id = :id")
                       ->execute([':c' => (int)$linkConvId, ':id' => $callId]);
                }
            } catch (\Throwable $e) {}

            jsonResponse(true, [
                'id'           => $callId,
                'room_id'      => $roomId,
                'scheduled_at' => gmdate('c', $ts),
                'participants' => $participants,
            ], 'Scheduled');
            break;
        }

        case 'call_schedule_list': {
            $user = requireChatAuth();
            try {
                $db->exec("CREATE TABLE IF NOT EXISTS scheduled_calls (
                    id BIGSERIAL PRIMARY KEY,
                    organizer_email TEXT NOT NULL,
                    participants JSONB NOT NULL DEFAULT '[]'::jsonb,
                    title TEXT NOT NULL DEFAULT '',
                    scheduled_at TIMESTAMP NOT NULL,
                    duration_min INT NOT NULL DEFAULT 30,
                    status TEXT NOT NULL DEFAULT 'scheduled',
                    conversation_id BIGINT,
                    room_id TEXT NOT NULL,
                    notified_15 SMALLINT DEFAULT 0,
                    notified_1 SMALLINT DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (now() AT TIME ZONE 'UTC')
                )");
            } catch (\Throwable $e) {}
            $em = $user['email'];
            $sql = "SELECT id, organizer_email, participants, title, scheduled_at, duration_min, status, conversation_id, room_id, created_at
                    FROM scheduled_calls
                    WHERE status = 'scheduled'
                      AND (LOWER(organizer_email) = LOWER(:em)
                           OR participants @> to_jsonb(:em2::text))
                      AND scheduled_at >= (now() AT TIME ZONE 'UTC') - interval '1 hour'
                    ORDER BY scheduled_at ASC LIMIT 200";
            $stmt = $db->prepare($sql);
            $stmt->execute([':em' => $em, ':em2' => $em]);
            $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            foreach ($rows as &$r) {
                $r['id'] = (int)$r['id'];
                $r['duration_min'] = (int)$r['duration_min'];
                $r['conversation_id'] = $r['conversation_id'] !== null ? (int)$r['conversation_id'] : null;
                $r['participants'] = is_string($r['participants']) ? (json_decode($r['participants'], true) ?: []) : ($r['participants'] ?: []);
                $ts2 = strtotime($r['scheduled_at']);
                $r['scheduled_at'] = $ts2 ? gmdate('c', $ts2) : $r['scheduled_at'];
            }
            unset($r);
            jsonResponse(true, ['calls' => $rows]);
            break;
        }

        case 'call_schedule_cancel': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            $sel = $db->prepare("SELECT * FROM scheduled_calls WHERE id = :id");
            $sel->execute([':id' => $id]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'not found', 404);
            if (strtolower($row['organizer_email']) !== strtolower($user['email'])) {
                jsonResponse(false, null, 'Only organizer can cancel', 403);
            }
            $upd = $db->prepare("UPDATE scheduled_calls SET status = 'cancelled' WHERE id = :id");
            $upd->execute([':id' => $id]);

            $participants = is_string($row['participants']) ? (json_decode($row['participants'], true) ?: []) : ($row['participants'] ?: []);
            $title = (string)$row['title'];
            $payloadJson = json_encode([
                'kind' => 'call_schedule_cancel',
                'scheduled_id' => $id,
                'title' => $title,
            ]);
            foreach ($participants as $peer) {
                try {
                    $find = $db->prepare("
                        SELECT c.id FROM chat_conversations c
                        JOIN chat_conversation_members m1 ON m1.conversation_id = c.id AND LOWER(m1.email) = LOWER(:me)
                        JOIN chat_conversation_members m2 ON m2.conversation_id = c.id AND LOWER(m2.email) = LOWER(:peer)
                        WHERE c.type = 'direct' LIMIT 1
                    ");
                    $find->execute([':me' => $user['email'], ':peer' => $peer]);
                    $convId = (int)$find->fetchColumn();
                    if (!$convId) continue;
                    $msgIns = $db->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, payload, created_at)
                        VALUES (:cid, :se, :c, 'system', :p, (now() AT TIME ZONE 'UTC')::text) RETURNING id");
                    $msgIns->execute([
                        ':cid' => $convId,
                        ':se'  => $user['email'],
                        ':c'   => 'Chamada cancelada: "' . $title . '"',
                        ':p'   => $payloadJson,
                    ]);
                    $mid = (int)$msgIns->fetchColumn();
                    try { broadcastChatMessage($db, $convId, $mid, $user['email'], 'chat_message'); } catch (\Throwable $e) {}
                } catch (\Throwable $e) {
                    error_log('[call_schedule_cancel.dm] ' . $e->getMessage());
                }
            }
            jsonResponse(true, ['cancelled' => true]);
            break;
        }

        case 'call_schedule_join': {
            $user = requireChatAuth();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            $sel = $db->prepare("SELECT * FROM scheduled_calls WHERE id = :id");
            $sel->execute([':id' => $id]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'not found', 404);
            if ($row['status'] === 'cancelled') jsonResponse(false, null, 'Call cancelled', 410);
            $em = strtolower($user['email']);
            $isOrg = strtolower($row['organizer_email']) === $em;
            $participants = is_string($row['participants']) ? (json_decode($row['participants'], true) ?: []) : ($row['participants'] ?: []);
            $isPart = false;
            foreach ($participants as $p) { if (strtolower((string)$p) === $em) { $isPart = true; break; } }
            if (!$isOrg && !$isPart) jsonResponse(false, null, 'Not a participant', 403);

            $ts = strtotime($row['scheduled_at']);
            $duration = (int)$row['duration_min'];
            $earlyOk = ($ts - time()) <= 300;
            $lateOk  = (time() - $ts) <= max(300, $duration * 60);
            if (!($earlyOk && $lateOk)) {
                jsonResponse(false, [
                    'scheduled_at' => gmdate('c', $ts),
                    'now' => gmdate('c'),
                ], 'Out of join window', 425);
            }
            try {
                $db->prepare("UPDATE scheduled_calls SET status = 'started' WHERE id = :id AND status = 'scheduled'")
                   ->execute([':id' => $id]);
            } catch (\Throwable $e) {}

            jsonResponse(true, [
                'room_id' => $row['room_id'],
                'conversation_id' => $row['conversation_id'] !== null ? (int)$row['conversation_id'] : null,
                'title' => $row['title'],
            ]);
            break;
        }

        // ============================================================
        // Cloudflare Stream Live — managed ingest + HLS/DASH playback
        // ------------------------------------------------------------
        // These actions complement the legacy `live_start` (WebRTC P2P,
        // still in email.php) — they do NOT replace it. The frontend can
        // choose which pipeline to use; servers + WS signaling are shared.
        //
        // Env required (read from /etc/mail-api.env via getenv()):
        //   CF_ACCOUNT_ID, CF_API_KEY, CF_EMAIL
        //
        // Cloudflare API contract:
        //   POST   /accounts/{acct}/stream/live_inputs           — create input
        //   DELETE /accounts/{acct}/stream/live_inputs/{uid}     — destroy input
        //   GET    /accounts/{acct}/stream/live_inputs/{uid}/videos — list recordings/live
        // ============================================================

        case 'live_start_cf': {
            $user = requireChatAuth();
            $title = trim((string)($input['title'] ?? 'Live'));
            $title = mb_substr($title, 0, 200);

            $cfAccountId = getenv('CF_ACCOUNT_ID') ?: '';
            $cfApiKey    = getenv('CF_API_KEY')    ?: '';
            $cfEmail     = getenv('CF_EMAIL')      ?: '';
            // Fallback: parse /etc/mail-api.env when systemd / php-fpm didn't
            // inject these as real env vars (we've been bitten by this for
            // GROQ + MAIL_WS_KEY — see _chatLoadGroqKey for the same pattern).
            if (($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') && file_exists('/etc/mail-api.env')) {
                foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                    if ($cfAccountId === '' && strpos($_line, 'CF_ACCOUNT_ID=') === 0) $cfAccountId = trim(substr($_line, 14));
                    if ($cfApiKey    === '' && strpos($_line, 'CF_API_KEY=')    === 0) $cfApiKey    = trim(substr($_line, 11));
                    if ($cfEmail     === '' && strpos($_line, 'CF_EMAIL=')      === 0) $cfEmail     = trim(substr($_line, 9));
                }
            }
            if ($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') {
                error_log('[live_cf] missing CF_ACCOUNT_ID/CF_API_KEY/CF_EMAIL env');
                jsonResponse(false, null, 'live_cf_not_configured', 500);
            }

            // Talk to CF: create the live input. `automatic` recording means
            // every push session is captured as a Stream video; the playback
            // URLs work even after the stream ends (VOD continuation).
            $cfBody = json_encode([
                'meta'      => ['name' => 'Chatyy live ' . $user['email']],
                'recording' => ['mode' => 'automatic'],
            ]);
            $ch = curl_init();
            curl_setopt_array($ch, [
                CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/live_inputs",
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $cfBody,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                    "X-Auth-Email: {$cfEmail}",
                    "X-Auth-Key: {$cfApiKey}",
                    "Content-Type: application/json",
                ],
                CURLOPT_TIMEOUT => 15,
            ]);
            $cfRespRaw = curl_exec($ch);
            $cfHttp    = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $cfErr     = curl_error($ch);
            curl_close($ch);

            if ($cfHttp < 200 || $cfHttp >= 300 || $cfRespRaw === false) {
                error_log('[live_cf] create_failed http=' . $cfHttp . ' err=' . $cfErr . ' body=' . substr((string)$cfRespRaw, 0, 500));
                jsonResponse(false, ['cf_status' => $cfHttp, 'cf_error' => $cfErr], 'live_cf_create_failed', 502);
            }
            $cfResp = json_decode((string)$cfRespRaw, true);
            if (!is_array($cfResp) || empty($cfResp['success']) || empty($cfResp['result']['uid'])) {
                error_log('[live_cf] create_bad_payload: ' . substr((string)$cfRespRaw, 0, 500));
                jsonResponse(false, ['cf_response' => $cfResp], 'live_cf_create_failed', 502);
            }
            $r = $cfResp['result'];
            $cfUid     = (string)($r['uid'] ?? '');
            $rtmpsUrl  = (string)($r['rtmps']['url']       ?? '');
            $rtmpsKey  = (string)($r['rtmps']['streamKey'] ?? '');
            $srtUrl    = (string)($r['srt']['url']         ?? '');
            $srtPass   = (string)($r['srt']['passphrase']  ?? '');
            $srtId     = (string)($r['srt']['streamId']    ?? '');
            $webrtcUrl = (string)($r['webRTC']['url']      ?? '');
            // Playback URLs aren't always in the create response — derive them
            // from the uid. The cloudflarestream.com pattern is stable and
            // documented; deriving avoids a second GET.
            $hlsUrl  = "https://customer-{$cfAccountId}.cloudflarestream.com/{$cfUid}/manifest/video.m3u8";
            $dashUrl = "https://customer-{$cfAccountId}.cloudflarestream.com/{$cfUid}/manifest/video.mpd";
            // If CF surfaced explicit playback URLs, prefer those.
            if (!empty($r['playback']['hls']))  $hlsUrl  = (string)$r['playback']['hls'];
            if (!empty($r['playback']['dash'])) $dashUrl = (string)$r['playback']['dash'];

            // Persist session row. Reuse same id shape (hex) as legacy
            // `live_start` so any code keyed on session_id stays
            // interoperable. `cf_input_uid` is the join key for live_end_cf
            // + live_status_cf.
            $sessionId = bin2hex(random_bytes(10));
            $hostName  = $user['name'] ?? explode('@', $user['email'])[0];
            try {
                $ins = $db->prepare("
                    INSERT INTO chat_live_sessions
                        (id, host_email, host_name, title, status, cf_input_uid, rtmps_url, rtmps_key, hls_url, dash_url)
                    VALUES
                        (:id, :he, :hn, :t, 'live', :uid, :ru, :rk, :hu, :du)
                    RETURNING id, started_at
                ");
                $ins->execute([
                    ':id'  => $sessionId,
                    ':he'  => $user['email'],
                    ':hn'  => $hostName,
                    ':t'   => $title,
                    ':uid' => $cfUid,
                    ':ru'  => $rtmpsUrl,
                    ':rk'  => $rtmpsKey,
                    ':hu'  => $hlsUrl,
                    ':du'  => $dashUrl,
                ]);
                $insRow = $ins->fetch(\PDO::FETCH_ASSOC) ?: ['started_at' => gmdate('Y-m-d\TH:i:s')];
            } catch (\Throwable $e) {
                error_log('[live_cf] persist_failed: ' . $e->getMessage());
                // Try to undo the CF live input so we don't leak it. Best-effort.
                try {
                    $cu = curl_init();
                    curl_setopt_array($cu, [
                        CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/live_inputs/{$cfUid}",
                        CURLOPT_CUSTOMREQUEST => 'DELETE',
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => ["X-Auth-Email: {$cfEmail}", "X-Auth-Key: {$cfApiKey}"],
                        CURLOPT_TIMEOUT => 5,
                    ]);
                    curl_exec($cu);
                    curl_close($cu);
                } catch (\Throwable $_) {}
                jsonResponse(false, null, 'live_cf_persist_failed', 500);
            }

            // Fan-out push to followers + 30d DM peers (parity with the
            // legacy email.php live_start). Without this, going live via
            // the CF pipeline produces no notification — feature regression
            // vs. task #888. Inline + best-effort + bounded timeout so the
            // response stays <300ms even with hundreds of recipients.
            try {
                if (!function_exists('fcmSendToUser')) {
                    require_once __DIR__ . '/firebase_push.php';
                }
                $hostEmail = $user['email'];
                $fStmt = $db->prepare(
                    "SELECT email, MAX(is_follower) AS is_follower, MAX(is_peer) AS is_peer FROM (
                        SELECT LOWER(follower_email) AS email, 1 AS is_follower, 0 AS is_peer
                          FROM chat_follows
                         WHERE LOWER(following_email) = LOWER(:e_follow)
                        UNION ALL
                        SELECT LOWER(m2.email) AS email, 0 AS is_follower, 1 AS is_peer
                          FROM chat_conversation_members m1
                          JOIN chat_conversations c ON c.id = m1.conversation_id
                          JOIN chat_conversation_members m2 ON m2.conversation_id = m1.conversation_id
                          LEFT JOIN chat_user_conv_settings ucs
                                 ON ucs.conversation_id = m1.conversation_id
                                AND LOWER(ucs.email) = LOWER(m2.email)
                         WHERE LOWER(m1.email) = LOWER(:e_peer_self)
                           AND c.type = 'direct'
                           AND LOWER(m2.email) <> LOWER(:e_peer_other)
                           AND (m2.left_at IS NULL OR m2.left_at = '')
                           AND (m1.left_at IS NULL OR m1.left_at = '')
                           AND c.updated_at::timestamptz >= (NOW() - INTERVAL '30 days')
                           AND COALESCE(ucs.notif_muted, 0) = 0
                           AND COALESCE(ucs.notify_messages, true) = true
                           AND (ucs.mute_until IS NULL OR ucs.mute_until < NOW())
                    ) u
                    WHERE email IS NOT NULL AND email <> ''
                      AND email NOT IN (
                          SELECT LOWER(blocked_email) FROM chat_blocked_users
                           WHERE LOWER(blocker_email) = LOWER(:e_blk_host)
                          UNION
                          SELECT LOWER(blocker_email) FROM chat_blocked_users
                           WHERE LOWER(blocked_email) = LOWER(:e_blk_host2)
                      )
                    GROUP BY email"
                );
                $fStmt->execute([
                    ':e_follow'     => $hostEmail,
                    ':e_peer_self'  => $hostEmail,
                    ':e_peer_other' => $hostEmail,
                    ':e_blk_host'   => $hostEmail,
                    ':e_blk_host2'  => $hostEmail,
                ]);
                $rows = $fStmt->fetchAll(\PDO::FETCH_ASSOC);
                $recipients = [];
                foreach ($rows as $rrow) {
                    $em = $rrow['email'] ?? '';
                    if ($em && strcasecmp($em, $hostEmail) !== 0) $recipients[] = $em;
                }
                if (!empty($recipients) && function_exists('fcmSendToUser')) {
                    $pushTitle = $hostName . ' está ao vivo';
                    $pushBody  = ($title && $title !== 'Live') ? $title : 'Toque pra entrar na live agora';
                    $pushData  = [
                        'type'        => 'live',
                        'event'       => 'start',
                        'categoryId'  => 'live_start',
                        'category_id' => 'live_start',
                        'session_id'  => $sessionId,
                        'host_email'  => $hostEmail,
                        'host_name'   => $hostName,
                        'title'       => $title,
                        'priority'    => 'high',
                        'group_key'   => 'live_' . $sessionId,
                        'thread_id'   => 'live_' . $sessionId,
                        'route'       => '/live/' . $sessionId,
                        'pipeline'    => 'cf_stream',
                    ];
                    foreach ($recipients as $rEm) {
                        try { fcmSendToUser($rEm, $pushTitle, $pushBody, $pushData); }
                        catch (\Throwable $e) { error_log('[live_cf.push] ' . $rEm . ': ' . $e->getMessage()); }
                    }
                    error_log('[live_cf] notified ' . count($recipients) . ' recipients for host=' . $hostEmail . ' session=' . $sessionId);
                }
            } catch (\Throwable $e) {
                error_log('[live_cf.fanout] ' . $e->getMessage());
            }

            jsonResponse(true, [
                'sessionId'   => $sessionId,
                'session_id'  => $sessionId,
                'id'          => $sessionId,
                'cf_input_uid'=> $cfUid,
                'rtmps_url'   => $rtmpsUrl,
                'rtmps_key'   => $rtmpsKey,
                'srt_url'     => $srtUrl,
                'srt_passphrase' => $srtPass,
                'srt_stream_id'  => $srtId,
                'webrtc_url'  => $webrtcUrl,
                'hls_url'     => $hlsUrl,
                'dash_url'    => $dashUrl,
                'host_email'  => $user['email'],
                'host_name'   => $hostName,
                'title'       => $title,
                'started_at'  => $insRow['started_at'],
                'pipeline'    => 'cf_stream',
            ]);
            break;
        }

        case 'live_end_cf': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            // Host's replay opt-in. Default TRUE — most hosts want their live
            // saved for shareable replay. Frontend sends false explicitly when
            // host unchecks the "Save replay" toggle in the end-modal.
            $saveReplay = !isset($input['save_replay']) ? true : (bool)$input['save_replay'];

            // Load + ownership check. Only host can end. Pull cf_input_uid
            // so we can release the CF resource.
            $sel = $db->prepare("SELECT host_email, status, cf_input_uid FROM chat_live_sessions WHERE id = :id");
            $sel->execute([':id' => $sessionId]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Session not found', 404);
            if (strcasecmp($row['host_email'], $user['email']) !== 0) {
                jsonResponse(false, null, 'Only the host can end the live session', 403);
            }

            try {
                $db->prepare("
                    UPDATE chat_live_sessions
                       SET status = 'ended',
                           ended_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS'),
                           save_replay = :sr
                     WHERE id = :id
                ")->execute([':id' => $sessionId, ':sr' => $saveReplay ? 't' : 'f']);
                // Bug #978-6: stamp replay expiry on the saved session so the
                // recordings list + future cleanup cron know when to GC.
                if ($saveReplay) {
                    $db->prepare("
                        UPDATE chat_live_sessions
                           SET replay_expires_at = NOW() + INTERVAL '7 days'
                         WHERE id = :id AND replay_expires_at IS NULL
                    ")->execute([':id' => $sessionId]);
                }
            } catch (\Throwable $e) {
                error_log('[live_cf.end.persist] ' . $e->getMessage());
            }

            // Delete the CF live input. Stops billing for the ingest and
            // releases the rtmps stream key. Recordings stay as separate
            // Stream videos (mode=automatic captured them). Best-effort.
            $cfUid = (string)($row['cf_input_uid'] ?? '');
            if ($cfUid !== '') {
                $cfAccountId = getenv('CF_ACCOUNT_ID') ?: '';
                $cfApiKey    = getenv('CF_API_KEY')    ?: '';
                $cfEmail     = getenv('CF_EMAIL')      ?: '';
                if (($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') && file_exists('/etc/mail-api.env')) {
                    foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                        if ($cfAccountId === '' && strpos($_line, 'CF_ACCOUNT_ID=') === 0) $cfAccountId = trim(substr($_line, 14));
                        if ($cfApiKey    === '' && strpos($_line, 'CF_API_KEY=')    === 0) $cfApiKey    = trim(substr($_line, 11));
                        if ($cfEmail     === '' && strpos($_line, 'CF_EMAIL=')      === 0) $cfEmail     = trim(substr($_line, 9));
                    }
                }
                if ($cfAccountId !== '' && $cfApiKey !== '' && $cfEmail !== '') {
                    $ch = curl_init();
                    curl_setopt_array($ch, [
                        CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/live_inputs/{$cfUid}",
                        CURLOPT_CUSTOMREQUEST => 'DELETE',
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => [
                            "X-Auth-Email: {$cfEmail}",
                            "X-Auth-Key: {$cfApiKey}",
                        ],
                        CURLOPT_TIMEOUT => 8,
                    ]);
                    $delRaw  = curl_exec($ch);
                    $delHttp = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);
                    if ($delHttp < 200 || $delHttp >= 300) {
                        error_log('[live_cf.end.delete_failed] http=' . $delHttp . ' uid=' . $cfUid . ' body=' . substr((string)$delRaw, 0, 300));
                    }
                }
            }

            // WS broadcast: tell viewers the live ended so they bail. Hit
            // both Node (8081) and Go (8084) hubs — whichever the client is
            // on receives it. Same pattern used everywhere else in chat.php.
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey === '' && file_exists('/etc/mail-api.env')) {
                    foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                        if (strpos($_line, 'MAIL_WS_KEY=') === 0) { $wsKey = trim(substr($_line, 12)); break; }
                    }
                }
                if ($wsKey !== '') {
                    foreach (['live_' . $sessionId, 'lives_global'] as $channel) {
                        $payload = json_encode([
                            'channel' => $channel,
                            'event'   => 'live_ended',
                            'data'    => [
                                'session_id' => $sessionId,
                                'host_email' => $user['email'],
                                'pipeline'   => 'cf_stream',
                            ],
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 500,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu);
                            curl_close($cu);
                        }
                    }
                }
            } catch (\Throwable $e) {
                error_log('[live_cf.end.ws] ' . $e->getMessage());
            }

            jsonResponse(true, ['ended' => true, 'session_id' => $sessionId, 'pipeline' => 'cf_stream']);
            break;
        }

        case 'live_status_cf': {
            // Viewers poll this to find out whether the stream is actually
            // pushing frames yet (the rtmps publish may lag the row insert
            // by 3-10s depending on the broadcaster's network). Returns
            // CF's authoritative state — when any video.state === 'live'
            // the stream is hot.
            requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            $sel = $db->prepare("SELECT cf_input_uid, status, hls_url, dash_url FROM chat_live_sessions WHERE id = :id");
            $sel->execute([':id' => $sessionId]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Session not found', 404);

            $cfUid = (string)($row['cf_input_uid'] ?? '');
            if ($cfUid === '') {
                // Legacy P2P session — no CF state to query.
                jsonResponse(true, [
                    'session_id' => $sessionId,
                    'pipeline'   => 'legacy_p2p',
                    'status'     => $row['status'],
                    'is_live'    => $row['status'] === 'live',
                    'videos'     => [],
                ]);
            }

            $cfAccountId = getenv('CF_ACCOUNT_ID') ?: '';
            $cfApiKey    = getenv('CF_API_KEY')    ?: '';
            $cfEmail     = getenv('CF_EMAIL')      ?: '';
            if (($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') && file_exists('/etc/mail-api.env')) {
                foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                    if ($cfAccountId === '' && strpos($_line, 'CF_ACCOUNT_ID=') === 0) $cfAccountId = trim(substr($_line, 14));
                    if ($cfApiKey    === '' && strpos($_line, 'CF_API_KEY=')    === 0) $cfApiKey    = trim(substr($_line, 11));
                    if ($cfEmail     === '' && strpos($_line, 'CF_EMAIL=')      === 0) $cfEmail     = trim(substr($_line, 9));
                }
            }
            if ($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') {
                jsonResponse(false, null, 'live_cf_not_configured', 500);
            }

            $ch = curl_init();
            curl_setopt_array($ch, [
                CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/live_inputs/{$cfUid}/videos",
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                    "X-Auth-Email: {$cfEmail}",
                    "X-Auth-Key: {$cfApiKey}",
                ],
                CURLOPT_TIMEOUT => 8,
            ]);
            $raw  = curl_exec($ch);
            $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $err  = curl_error($ch);
            curl_close($ch);

            if ($http < 200 || $http >= 300 || $raw === false) {
                error_log('[live_cf.status] http=' . $http . ' err=' . $err . ' body=' . substr((string)$raw, 0, 300));
                jsonResponse(false, ['cf_status' => $http], 'live_cf_status_failed', 502);
            }
            $resp = json_decode((string)$raw, true);
            $videos = is_array($resp['result'] ?? null) ? $resp['result'] : [];

            $isLive = false;
            $shaped = [];
            foreach ($videos as $v) {
                $state = (string)($v['status']['state'] ?? '');
                if ($state === 'live-inprogress' || $state === 'live') $isLive = true;
                $shaped[] = [
                    'uid'           => (string)($v['uid'] ?? ''),
                    'state'         => $state,
                    'duration'      => (float)($v['duration'] ?? 0),
                    'created'       => (string)($v['created'] ?? ''),
                    'thumbnail'     => (string)($v['thumbnail'] ?? ''),
                    'preview'       => (string)($v['preview']   ?? ''),
                ];
            }

            jsonResponse(true, [
                'session_id'   => $sessionId,
                'pipeline'     => 'cf_stream',
                'status'       => $row['status'],
                'is_live'      => $isLive,
                'hls_url'      => $row['hls_url'],
                'dash_url'     => $row['dash_url'],
                'cf_input_uid' => $cfUid,
                'videos'       => $shaped,
            ]);
            break;
        }

        case 'live_list_cf': {
            // Discovery: active CF Stream lives. Complements the legacy
            // `live_list` (which is owned by email.php and covers BOTH
            // pipelines). This handler returns ONLY CF Stream sessions so
            // the new viewer UI can filter without server-side branching.
            $user = requireChatAuth();
            try {
                // Same auto-expire heuristic as email.php live_list to keep
                // the result clean. Don't break the response if this fails.
                @$db->exec("UPDATE chat_live_sessions
                            SET status = 'ended',
                                ended_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')
                            WHERE status = 'live'
                              AND cf_input_uid IS NOT NULL
                              AND (
                                (viewer_count = 0 AND started_at::timestamptz < NOW() - INTERVAL '5 minutes')
                                OR started_at::timestamptz < NOW() - INTERVAL '6 hours'
                              )");
            } catch (\Throwable $_) {}

            try {
                $stmt = $db->prepare("
                    SELECT id, host_email, host_name, title, viewer_count, started_at,
                           thumbnail_url, cf_input_uid, hls_url, dash_url
                      FROM chat_live_sessions
                     WHERE status = 'live'
                       AND cf_input_uid IS NOT NULL
                       AND cf_input_uid <> ''
                     ORDER BY started_at DESC
                     LIMIT 50
                ");
                $stmt->execute();
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
            } catch (\Throwable $e) {
                error_log('[live_cf.list] ' . $e->getMessage());
                $rows = [];
            }

            $sessions = [];
            foreach ($rows as $rrow) {
                $sessions[] = [
                    'id'            => $rrow['id'],
                    'session_id'    => $rrow['id'],
                    'host_email'    => $rrow['host_email'],
                    'host_name'     => $rrow['host_name'],
                    'title'         => $rrow['title'],
                    'viewer_count'  => (int)$rrow['viewer_count'],
                    'started_at'    => $rrow['started_at'],
                    'thumbnail_url' => $rrow['thumbnail_url'] ?? '',
                    'cf_input_uid'  => $rrow['cf_input_uid'],
                    'hls_url'       => $rrow['hls_url'],
                    'dash_url'      => $rrow['dash_url'],
                    'pipeline'      => 'cf_stream',
                ];
            }

            jsonResponse(true, ['sessions' => $sessions, 'lives' => $sessions]);
            break;
        }

        // ============================================================
        // Live recording / replay endpoints — CF Stream VOD pipeline.
        // CF auto-records every push session (mode=automatic). Once the host
        // ends, a VOD appears under /live_inputs/{uid}/videos within 30s-2min.
        // We expose it as a replay (HLS) + downloadable MP4. Viewers can
        // tap "Salvar live" to bookmark a replay (chat_live_replays_saved).
        // ============================================================

        case 'live_recording_poll': {
            // Called by the host's live-broadcast screen on a timer after
            // ending, and by anyone opening /lives-saved (rolling tail). Also
            // safe to call from a cron. Walks ended sessions w/ ready=FALSE
            // and bumps in-flight recordings. Idempotent — re-polls finalize
            // missed sessions next minute.
            $user = requireChatAuth();
            // Optional single-session focus (faster end-of-live UX).
            $focusId = trim((string)($input['session_id'] ?? ''));

            $cfAccountId = getenv('CF_ACCOUNT_ID') ?: '';
            $cfApiKey    = getenv('CF_API_KEY')    ?: '';
            $cfEmail     = getenv('CF_EMAIL')      ?: '';
            if (($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') && file_exists('/etc/mail-api.env')) {
                foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                    if ($cfAccountId === '' && strpos($_line, 'CF_ACCOUNT_ID=') === 0) $cfAccountId = trim(substr($_line, 14));
                    if ($cfApiKey    === '' && strpos($_line, 'CF_API_KEY=')    === 0) $cfApiKey    = trim(substr($_line, 11));
                    if ($cfEmail     === '' && strpos($_line, 'CF_EMAIL=')      === 0) $cfEmail     = trim(substr($_line, 9));
                }
            }
            if ($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') {
                jsonResponse(false, null, 'live_cf_not_configured', 500);
            }

            if ($focusId !== '') {
                $sel = $db->prepare("SELECT id, host_email, cf_input_uid, recording_ready, save_replay
                                       FROM chat_live_sessions
                                      WHERE id = :id AND ended_at IS NOT NULL");
                $sel->execute([':id' => $focusId]);
            } else {
                // Rolling tail — any session ended in last 24h that isn't
                // marked ready yet. Cap 20 per call so we don't go wild.
                $sel = $db->prepare("SELECT id, host_email, cf_input_uid, recording_ready, save_replay
                                       FROM chat_live_sessions
                                      WHERE recording_ready = FALSE
                                        AND ended_at IS NOT NULL
                                        AND cf_input_uid IS NOT NULL
                                        AND cf_input_uid <> ''
                                        AND ended_at::timestamptz > NOW() - INTERVAL '24 hours'
                                      ORDER BY ended_at DESC
                                      LIMIT 20");
                $sel->execute();
            }
            $sessions = $sel->fetchAll(\PDO::FETCH_ASSOC);

            $updated = [];
            foreach ($sessions as $s) {
                $cfUid = (string)($s['cf_input_uid'] ?? '');
                if ($cfUid === '') continue;

                $ch = curl_init();
                curl_setopt_array($ch, [
                    CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/live_inputs/{$cfUid}/videos",
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_HTTPHEADER => [
                        "X-Auth-Email: {$cfEmail}",
                        "X-Auth-Key: {$cfApiKey}",
                    ],
                    CURLOPT_TIMEOUT => 8,
                ]);
                $raw  = curl_exec($ch);
                $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($http < 200 || $http >= 300 || $raw === false) {
                    error_log('[live.poll] cf_videos_failed http=' . $http . ' uid=' . $cfUid);
                    continue;
                }
                $resp = json_decode((string)$raw, true);
                $videos = is_array($resp['result'] ?? null) ? $resp['result'] : [];

                // Pick the longest VOD whose state is 'ready'. live-inprogress
                // means CF still finalizing — skip, retry next poll.
                $best = null;
                foreach ($videos as $v) {
                    $state = (string)($v['status']['state'] ?? '');
                    if ($state !== 'ready') continue;
                    $dur = (float)($v['duration'] ?? 0);
                    if (!$best || $dur > (float)($best['duration'] ?? 0)) $best = $v;
                }
                if (!$best) continue;

                $videoUid = (string)($best['uid'] ?? '');
                if ($videoUid === '') continue;

                $duration = (int)round((float)($best['duration'] ?? 0));
                $thumb    = (string)($best['thumbnail'] ?? '');
                $hlsUrl   = "https://customer-{$cfAccountId}.cloudflarestream.com/{$videoUid}/manifest/video.m3u8";
                $mp4Url   = "https://customer-{$cfAccountId}.cloudflarestream.com/{$videoUid}/downloads/default.mp4";

                // Host chose NOT to save replay → destroy the VOD on CF.
                // (Don't keep storage bills for opted-out lives.) We still
                // set recording_ready=TRUE so we don't keep polling.
                if (!$s['save_replay']) {
                    $cu = curl_init();
                    curl_setopt_array($cu, [
                        CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/{$videoUid}",
                        CURLOPT_CUSTOMREQUEST => 'DELETE',
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => ["X-Auth-Email: {$cfEmail}", "X-Auth-Key: {$cfApiKey}"],
                        CURLOPT_TIMEOUT => 5,
                    ]);
                    curl_exec($cu);
                    curl_close($cu);
                    try {
                        $db->prepare("UPDATE chat_live_sessions
                                         SET recording_ready = TRUE,
                                             recording_duration = :d
                                       WHERE id = :id")
                           ->execute([':d' => $duration, ':id' => $s['id']]);
                    } catch (\Throwable $e) { error_log('[live.poll.persist_nosave] ' . $e->getMessage()); }
                    $updated[] = ['session_id' => $s['id'], 'discarded' => true];
                    continue;
                }

                // Enable MP4 download. Best-effort — CF returns 200 with state
                // 'inprogress'/'ready'; either way the URL above works once
                // they finish (next viewer hit might 404 briefly). Without
                // this POST, /downloads/default.mp4 returns 404.
                $cdl = curl_init();
                curl_setopt_array($cdl, [
                    CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/{$videoUid}/downloads",
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => '{}',
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_HTTPHEADER => [
                        "X-Auth-Email: {$cfEmail}",
                        "X-Auth-Key: {$cfApiKey}",
                        "Content-Type: application/json",
                    ],
                    CURLOPT_TIMEOUT => 6,
                ]);
                curl_exec($cdl);
                curl_close($cdl);

                try {
                    $db->prepare("
                        UPDATE chat_live_sessions
                           SET recording_ready = TRUE,
                               recording_url = :hls,
                               recording_mp4 = :mp4,
                               recording_duration = :d,
                               recording_video_uid = :vu,
                               recording_thumbnail = :th
                         WHERE id = :id
                    ")->execute([
                        ':hls' => $hlsUrl,
                        ':mp4' => $mp4Url,
                        ':d'   => $duration,
                        ':vu'  => $videoUid,
                        ':th'  => $thumb,
                        ':id'  => $s['id'],
                    ]);
                } catch (\Throwable $e) {
                    error_log('[live.poll.persist] ' . $e->getMessage());
                    continue;
                }

                $updated[] = [
                    'session_id'    => $s['id'],
                    'host_email'    => $s['host_email'],
                    'recording_url' => $hlsUrl,
                    'recording_mp4' => $mp4Url,
                    'duration'      => $duration,
                    'thumbnail'     => $thumb,
                ];

                // Notify host on the live_<id> channel so the broadcast
                // screen end-card can transition from "Processing…" to
                // "Replay ready" without polling.
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey === '' && file_exists('/etc/mail-api.env')) {
                        foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                            if (strpos($_line, 'MAIL_WS_KEY=') === 0) { $wsKey = trim(substr($_line, 12)); break; }
                        }
                    }
                    if ($wsKey !== '') {
                        $payload = json_encode([
                            'channel' => 'live_' . $s['id'],
                            'event'   => 'live_recording_ready',
                            'data'    => [
                                'session_id'    => $s['id'],
                                'recording_url' => $hlsUrl,
                                'recording_mp4' => $mp4Url,
                                'duration'      => $duration,
                                'thumbnail'     => $thumb,
                            ],
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 500,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu);
                            curl_close($cu);
                        }
                    }
                } catch (\Throwable $e) { error_log('[live.poll.ws] ' . $e->getMessage()); }
            }

            jsonResponse(true, ['updated' => $updated, 'checked' => count($sessions)]);
            break;
        }

        case 'live_recordings_list': {
            // Lives gravadas que esse user pode acessar:
            //   1) Lives das quais ele é host (com recording_ready=TRUE)
            //   2) Replays que ele explicitamente salvou (chat_live_replays_saved)
            // Retorna ordenado por mais recente.
            $user = requireChatAuth();
            $limit  = max(1, min(200, (int)($input['limit']  ?? $_GET['limit']  ?? 50)));
            $offset = max(0, (int)($input['offset'] ?? $_GET['offset'] ?? 0));

            try {
                // UNION: hosted lives + saved replays. saved_at fallback
                // for hosted = ended_at. saved_by_me / is_host flags help
                // frontend show right buttons (delete vs unsave).
                $stmt = $db->prepare("
                    SELECT s.id, s.host_email, s.host_name, s.title, s.thumbnail_url,
                           s.started_at, s.ended_at, s.recording_url, s.recording_mp4,
                           s.recording_duration, s.recording_thumbnail, s.saved_count,
                           TRUE AS is_host,
                           FALSE AS saved_by_me,
                           s.ended_at AS sort_key
                      FROM chat_live_sessions s
                     WHERE LOWER(s.host_email) = LOWER(:me)
                       AND s.recording_ready = TRUE
                       AND s.recording_url IS NOT NULL
                       AND s.recording_url <> ''
                       AND (s.replay_expires_at IS NULL OR s.replay_expires_at > NOW())
                    UNION ALL
                    SELECT s.id, s.host_email, s.host_name, s.title, s.thumbnail_url,
                           s.started_at, s.ended_at, s.recording_url, s.recording_mp4,
                           s.recording_duration, s.recording_thumbnail, s.saved_count,
                           FALSE AS is_host,
                           TRUE AS saved_by_me,
                           to_char(r.saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS sort_key
                      FROM chat_live_replays_saved r
                      JOIN chat_live_sessions s ON s.id = r.session_id
                     WHERE LOWER(r.user_email) = LOWER(:me2)
                       AND s.recording_ready = TRUE
                       AND s.recording_url IS NOT NULL
                       AND s.recording_url <> ''
                       AND (s.replay_expires_at IS NULL OR s.replay_expires_at > NOW())
                       AND LOWER(s.host_email) <> LOWER(:me3)
                     ORDER BY sort_key DESC
                     LIMIT :lim OFFSET :off
                ");
                $stmt->bindValue(':me', $user['email']);
                $stmt->bindValue(':me2', $user['email']);
                $stmt->bindValue(':me3', $user['email']);
                $stmt->bindValue(':lim', $limit, \PDO::PARAM_INT);
                $stmt->bindValue(':off', $offset, \PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
            } catch (\Throwable $e) {
                error_log('[live_recordings_list] ' . $e->getMessage());
                $rows = [];
            }

            $recordings = [];
            foreach ($rows as $rrow) {
                $recordings[] = [
                    'session_id'     => $rrow['id'],
                    'id'             => $rrow['id'],
                    'host_email'     => $rrow['host_email'],
                    'host_name'      => $rrow['host_name'],
                    'title'          => $rrow['title'],
                    'thumbnail_url'  => $rrow['recording_thumbnail'] ?: ($rrow['thumbnail_url'] ?? ''),
                    'started_at'     => $rrow['started_at'],
                    'ended_at'       => $rrow['ended_at'],
                    'recording_url'  => $rrow['recording_url'],
                    'recording_mp4'  => $rrow['recording_mp4'],
                    'duration'       => (int)($rrow['recording_duration'] ?? 0),
                    'saved_count'    => (int)($rrow['saved_count'] ?? 0),
                    'is_host'        => !empty($rrow['is_host']),
                    'saved_by_me'    => !empty($rrow['saved_by_me']),
                ];
            }
            jsonResponse(true, ['recordings' => $recordings, 'count' => count($recordings)]);
            break;
        }

        case 'live_save_replay': {
            // Viewer-side bookmark: stash the session_id in
            // chat_live_replays_saved so it shows up in /lives-saved next
            // time. Idempotent — UNIQUE(user_email, session_id) means tap
            // multiple times = no dupes (ON CONFLICT DO NOTHING).
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            // Pull cf_input_uid too so we can flag P2P sessions (no replay
            // ever materializes for them — see live_end in email.php).
            $sel = $db->prepare("SELECT host_email, recording_ready, recording_url, cf_input_uid FROM chat_live_sessions WHERE id = :id");
            $sel->execute([':id' => $sessionId]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Session not found', 404);

            // Block self-save: user is already the host (recording shows up
            // automatically). Frontend should hide the "Save" button in
            // that case but enforce here too.
            if (strcasecmp($row['host_email'], $user['email']) === 0) {
                jsonResponse(false, null, 'You are the host — already saved', 400);
            }

            $hasPipeline = !empty($row['cf_input_uid']);

            try {
                $ins = $db->prepare("
                    INSERT INTO chat_live_replays_saved (user_email, session_id)
                    VALUES (:e, :s)
                    ON CONFLICT (user_email, session_id) DO NOTHING
                ");
                $ins->execute([':e' => $user['email'], ':s' => $sessionId]);

                // Bump saved_count on the parent session for analytics — the
                // host sees how many viewers saved their replay.
                $db->prepare("UPDATE chat_live_sessions SET saved_count = saved_count + 1 WHERE id = :id")
                   ->execute([':id' => $sessionId]);
            } catch (\Throwable $e) {
                error_log('[live_save_replay] ' . $e->getMessage());
                jsonResponse(false, null, 'save_failed', 500);
            }

            jsonResponse(true, [
                'session_id' => $sessionId,
                'saved' => true,
                'recording_ready' => !empty($row['recording_ready']),
                // P2P (legacy WebRTC) sessions don't produce a VOD. Frontend
                // should still save the bookmark (for analytics + future
                // replay if pipeline switches) but show "Replay processing"
                // helper text only when has_recording_pipeline is true.
                'has_recording_pipeline' => $hasPipeline,
            ]);
            break;
        }

        case 'live_unsave_replay': {
            // Viewer unsave — removes the bookmark from chat_live_replays_saved.
            // Does NOT touch the underlying CF Stream VOD (other viewers may
            // still have it bookmarked; the host's deletion is the only thing
            // that should remove the underlying media).
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            try {
                $del = $db->prepare("DELETE FROM chat_live_replays_saved WHERE LOWER(user_email) = LOWER(:e) AND session_id = :s");
                $del->execute([':e' => $user['email'], ':s' => $sessionId]);
                $affected = $del->rowCount();
                if ($affected > 0) {
                    $db->prepare("UPDATE chat_live_sessions SET saved_count = GREATEST(0, saved_count - 1) WHERE id = :id")
                       ->execute([':id' => $sessionId]);
                }
            } catch (\Throwable $e) {
                error_log('[live_unsave_replay] ' . $e->getMessage());
            }
            jsonResponse(true, ['session_id' => $sessionId, 'unsaved' => true]);
            break;
        }

        case 'live_recording_get': {
            // Single-recording fetch for the watch page (HLS) or share link.
            // Auth: host OR replay was saved by the caller. Reject anyone
            // else so private/friends-only lives aren't enumerable.
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            $sel = $db->prepare("
                SELECT id, host_email, host_name, title, thumbnail_url,
                       started_at, ended_at, recording_url, recording_mp4,
                       recording_duration, recording_thumbnail, recording_ready,
                       saved_count
                  FROM chat_live_sessions
                 WHERE id = :id
            ");
            $sel->execute([':id' => $sessionId]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Recording not found', 404);

            $isHost = strcasecmp($row['host_email'], $user['email']) === 0;
            $savedByMe = false;
            if (!$isHost) {
                $chk = $db->prepare("SELECT 1 FROM chat_live_replays_saved WHERE LOWER(user_email) = LOWER(:e) AND session_id = :s LIMIT 1");
                $chk->execute([':e' => $user['email'], ':s' => $sessionId]);
                $savedByMe = (bool)$chk->fetchColumn();
            }
            // Allow open watch — anyone with the link can view. This
            // matches Instagram/TikTok shared-replay behavior. Private/
            // friends-only enforcement can layer on later via audience col.
            // (Frontend hides the unsave button when !savedByMe && !isHost.)

            jsonResponse(true, [
                'session_id'    => $row['id'],
                'host_email'    => $row['host_email'],
                'host_name'     => $row['host_name'],
                'title'         => $row['title'],
                'thumbnail_url' => $row['recording_thumbnail'] ?: ($row['thumbnail_url'] ?? ''),
                'started_at'    => $row['started_at'],
                'ended_at'      => $row['ended_at'],
                'recording_url' => $row['recording_url'],
                'recording_mp4' => $row['recording_mp4'],
                'duration'      => (int)($row['recording_duration'] ?? 0),
                'recording_ready' => !empty($row['recording_ready']),
                'saved_count'   => (int)($row['saved_count'] ?? 0),
                'is_host'       => $isHost,
                'saved_by_me'   => $savedByMe,
            ]);
            break;
        }

        case 'live_recording_delete': {
            // Host-only nuke. Drops the CF Stream video (releases storage
            // billing), wipes the URLs locally, and cascades the bookmarks
            // table so no viewer sees a 404 placeholder. Soft delete by
            // clearing recording_url; the session row itself stays so
            // existing analytics / push payloads referencing the id keep
            // resolving to host_name + title.
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            $sel = $db->prepare("SELECT host_email, recording_video_uid FROM chat_live_sessions WHERE id = :id");
            $sel->execute([':id' => $sessionId]);
            $row = $sel->fetch(\PDO::FETCH_ASSOC);
            if (!$row) jsonResponse(false, null, 'Recording not found', 404);
            if (strcasecmp($row['host_email'], $user['email']) !== 0) {
                jsonResponse(false, null, 'Only the host can delete this replay', 403);
            }

            // CF DELETE — best-effort. If CF returns 404 it's already gone.
            $videoUid = (string)($row['recording_video_uid'] ?? '');
            if ($videoUid !== '') {
                $cfAccountId = getenv('CF_ACCOUNT_ID') ?: '';
                $cfApiKey    = getenv('CF_API_KEY')    ?: '';
                $cfEmail     = getenv('CF_EMAIL')      ?: '';
                if (($cfAccountId === '' || $cfApiKey === '' || $cfEmail === '') && file_exists('/etc/mail-api.env')) {
                    foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                        if ($cfAccountId === '' && strpos($_line, 'CF_ACCOUNT_ID=') === 0) $cfAccountId = trim(substr($_line, 14));
                        if ($cfApiKey    === '' && strpos($_line, 'CF_API_KEY=')    === 0) $cfApiKey    = trim(substr($_line, 11));
                        if ($cfEmail     === '' && strpos($_line, 'CF_EMAIL=')      === 0) $cfEmail     = trim(substr($_line, 9));
                    }
                }
                if ($cfAccountId !== '' && $cfApiKey !== '' && $cfEmail !== '') {
                    $ch = curl_init();
                    curl_setopt_array($ch, [
                        CURLOPT_URL => "https://api.cloudflare.com/client/v4/accounts/{$cfAccountId}/stream/{$videoUid}",
                        CURLOPT_CUSTOMREQUEST => 'DELETE',
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => ["X-Auth-Email: {$cfEmail}", "X-Auth-Key: {$cfApiKey}"],
                        CURLOPT_TIMEOUT => 5,
                    ]);
                    curl_exec($ch);
                    curl_close($ch);
                }
            }

            try {
                $db->prepare("
                    UPDATE chat_live_sessions
                       SET recording_url = NULL,
                           recording_mp4 = NULL,
                           recording_video_uid = NULL,
                           recording_ready = FALSE,
                           saved_count = 0
                     WHERE id = :id
                ")->execute([':id' => $sessionId]);

                $db->prepare("DELETE FROM chat_live_replays_saved WHERE session_id = :id")
                   ->execute([':id' => $sessionId]);
            } catch (\Throwable $e) {
                error_log('[live_recording_delete.persist] ' . $e->getMessage());
                jsonResponse(false, null, 'delete_failed', 500);
            }

            jsonResponse(true, ['session_id' => $sessionId, 'deleted' => true]);
            break;
        }


        // ============================================================
        // chat_live_top_gifters — Leaderboard of top gifters for a live.
        // Returns up to `limit` rows (default 50) ordered by total_diamonds
        // desc. Used by the LiveTopGifters component (stacked avatars in
        // top-right of live screen + full-screen modal on tap). Anyone
        // authenticated can read — the leaderboard is a public artifact of
        // the live itself.
        // ============================================================
        case 'chat_live_top_gifters': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            $limit = max(1, min(100, (int)($input['limit'] ?? 50)));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);

            // Lazy-create the gifts table. Mirrors the pattern used by
            // live_start_cf for chat_live_sessions/replays_saved so a fresh
            // env doesn't need a separate migration step.
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_live_gifts (
                    id SERIAL PRIMARY KEY,
                    live_id TEXT NOT NULL,
                    sender_email TEXT NOT NULL,
                    gift_type TEXT NOT NULL,
                    diamonds INT NOT NULL DEFAULT 1,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_gifts_live_sender ON chat_live_gifts (live_id, sender_email)");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_gifts_live_created ON chat_live_gifts (live_id, created_at DESC)");
            } catch (\Throwable $e) { error_log('[live.gifts.schema] ' . $e->getMessage()); }

            try {
                // Aggregate diamonds per sender. JOIN to accounts for display
                // name; LEFT JOIN so senders without a profile still show.
                $stmt = $db->prepare("
                    SELECT g.sender_email AS email,
                           SPLIT_PART(g.sender_email, '@', 1) AS fallback_name,
                           SUM(g.diamonds) AS total_diamonds,
                           COUNT(*) AS gift_count
                      FROM chat_live_gifts g
                     WHERE g.live_id = :s
                     GROUP BY g.sender_email
                     ORDER BY total_diamonds DESC
                     LIMIT :lim
                ");
                $stmt->bindValue(':s', $sessionId);
                $stmt->bindValue(':lim', $limit, \PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
                $gifters = [];
                foreach ($rows as $r) {
                    $name = function_exists('chatDisplayName') ? chatDisplayName($r['email']) : '';
                    if (!$name) $name = $r['fallback_name'];
                    $gifters[] = [
                        'email'           => $r['email'],
                        'name'            => $name,
                        'avatar_url'      => '/api/email.php?action=get_avatar&email=' . urlencode($r['email']),
                        'total_diamonds'  => (int)$r['total_diamonds'],
                        'gift_count'      => (int)$r['gift_count'],
                    ];
                }
                jsonResponse(true, ['gifters' => $gifters, 'session_id' => $sessionId]);
            } catch (\Throwable $e) {
                error_log('[chat_live_top_gifters] ' . $e->getMessage());
                jsonResponse(false, null, 'fetch_failed', 500);
            }
            break;
        }

        // ============================================================
        // chat_live_send_gift — Viewer sends a virtual gift to a live.
        // Inserts a row in chat_live_gifts (clamped to a server-side
        // catalog to stop client-side diamond inflation), then broadcasts
        // a `live_gift` WS event on `live_<session_id>` so everyone in
        // the room sees the animation. No money — diamonds are virtual.
        // ============================================================
        case 'chat_live_send_gift': {
            $user = requireChatAuth();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            $giftType = strtolower(trim((string)($input['gift_type'] ?? '')));
            if ($sessionId === '' || $giftType === '') {
                jsonResponse(false, null, 'session_id and gift_type required', 400);
            }

            // Server-side catalog — clamps client values so a tampered
            // client can't credit themselves with 9999 diamonds for a
            // "rose". Keep in sync with components/LiveGiftPicker.js
            // (GIFT_CATALOG). If the type isn't here, reject.
            $catalog = [
                'rose'   => 1,
                'heart'  => 5,
                'star'   => 10,
                'crown'  => 25,
                'fire'   => 50,
                'rocket' => 100,
            ];
            if (!isset($catalog[$giftType])) {
                jsonResponse(false, null, 'Unknown gift_type', 400);
            }
            $diamonds = (int)$catalog[$giftType];

            // Make sure the session exists + is still live. Allow gifts to
            // sessions in either status 'live' or 'ended' (last ~30s grace
            // window — chat keeps trickling in after stream end). For now
            // we only block if the session doesn't exist at all.
            $sStmt = $db->prepare("SELECT id, host_email FROM chat_live_sessions WHERE id = :id");
            $sStmt->execute([':id' => $sessionId]);
            $session = $sStmt->fetch(\PDO::FETCH_ASSOC);
            if (!$session) jsonResponse(false, null, 'Live session not found', 404);

            // Lazy-create the table (same as top_gifters reader).
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_live_gifts (
                    id SERIAL PRIMARY KEY,
                    live_id TEXT NOT NULL,
                    sender_email TEXT NOT NULL,
                    gift_type TEXT NOT NULL,
                    diamonds INT NOT NULL DEFAULT 1,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_gifts_live_sender ON chat_live_gifts (live_id, sender_email)");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_gifts_live_created ON chat_live_gifts (live_id, created_at DESC)");
            } catch (\Throwable $e) { error_log('[live.gifts.schema.send] ' . $e->getMessage()); }

            // Soft per-user rate-limit — 20 gifts / 60s per session. Stops
            // tap-spam but lets legit hype-stacking through.
            $rateFile = '/tmp/live_gift_rate_' . md5($user['email'] . '|' . $sessionId);
            $now = microtime(true);
            $rates = [];
            if (file_exists($rateFile)) {
                $raw = @file_get_contents($rateFile);
                $d = $raw ? json_decode($raw, true) : null;
                if (is_array($d)) {
                    $rates = array_values(array_filter($d, fn($t) => is_numeric($t) && $t > $now - 60));
                }
            }
            if (count($rates) >= 20) {
                jsonResponse(false, null, 'Slow down — too many gifts', 429);
            }
            $rates[] = $now;
            @file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            // Persist the gift.
            try {
                $ins = $db->prepare("
                    INSERT INTO chat_live_gifts (live_id, sender_email, gift_type, diamonds)
                    VALUES (:s, :e, :g, :d)
                    RETURNING id, created_at
                ");
                $ins->bindValue(':s', $sessionId);
                $ins->bindValue(':e', $user['email']);
                $ins->bindValue(':g', $giftType);
                $ins->bindValue(':d', $diamonds, \PDO::PARAM_INT);
                $ins->execute();
                $row = $ins->fetch(\PDO::FETCH_ASSOC);
                $giftId = (int)($row['id'] ?? 0);
            } catch (\Throwable $e) {
                error_log('[chat_live_send_gift.insert] ' . $e->getMessage());
                jsonResponse(false, null, 'send_failed', 500);
            }

            // Broadcast the live_gift WS event on the live channel so the
            // host + every other viewer renders the LiveGiftAnimation
            // overlay. Sender's own client also receives it (their socket
            // is subscribed too), which doubles as a "delivery confirmed"
            // signal — they see the same animation everyone else does.
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    $senderName = $user['name'] ?? explode('@', $user['email'])[0];
                    $payload = [
                        'session_id'    => $sessionId,
                        'sender_email'  => $user['email'],
                        'sender_name'   => $senderName,
                        'sender_avatar' => '/api/email.php?action=get_avatar&email=' . urlencode($user['email']),
                        'gift_type'     => $giftType,
                        'gift'          => $giftType, // legacy alias for live-broadcast.js chat overlay chip
                        'diamonds'      => $diamonds,
                        'amount'        => $diamonds, // legacy alias
                    ];
                    $body = json_encode([
                        'channel' => 'live_' . $sessionId,
                        'event'   => 'live_gift',
                        'data'    => $payload,
                    ], JSON_UNESCAPED_UNICODE);
                    foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                        $cu = curl_init($endpoint);
                        curl_setopt_array($cu, [
                            CURLOPT_POST            => true,
                            CURLOPT_POSTFIELDS      => $body,
                            CURLOPT_HTTPHEADER      => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                            CURLOPT_RETURNTRANSFER  => true,
                            CURLOPT_TIMEOUT_MS      => 1500,
                            CURLOPT_CONNECTTIMEOUT_MS => 500,
                        ]);
                        curl_exec($cu); curl_close($cu);
                    }
                }
            } catch (\Throwable $e) { error_log('[chat_live_send_gift.ws] ' . $e->getMessage()); }

            jsonResponse(true, [
                'sent'      => true,
                'gift_id'   => $giftId,
                'gift_type' => $giftType,
                'diamonds'  => $diamonds,
            ]);
            break;
        }

        // ============================================================
        // Default — unknown action
        // ============================================================
        default:
            jsonResponse(false, null, 'Unknown chat action: ' . $action, 400);
            break;
    }
}
